import { describe, expect, test } from "bun:test";
import { summarizeGaps } from "../../src/gaps";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

// Entirely synthetic. The searched boundary differs from the oldest result,
// and an empty page still advances the search into older history.
const searched = ["2001-03-01T00:00:00Z", "2001-02-01T00:00:00Z"];
const loaded = "2001-03-02T00:00:00Z";
const recent = { hthId: "synthetic-recent", subject: "Recent example", organizationId: "synthetic-org" };
const boundary = { hthId: "synthetic-boundary", subject: "Boundary example", organizationId: "synthetic-org" };
const older = { hthId: "synthetic-older", subject: "Older example", organizationId: "synthetic-other-org" };
const page = (conversations: unknown[], more: boolean, cursor?: string, oldest = loaded) => ({
  conversations,
  localSummary: {
    hasMoreConversations: more,
    oldestSearchedInstantISO: cursor,
    oldestLoadedInstantISO: oldest,
    pagingInfo: 0, // response value is not the request's paging mode
  },
});

function clientFor(list: (init: FetchInit) => unknown, tag = 1) {
  return new FakeClient({
    "api/conversations/GetFoldersList": { folders: [{ tag }] },
    "api/conversations/GetOrganizations": { organizations: [] },
    "api/conversations/GetConversationList": (init: FetchInit) =>
      bodyOf(init).tag === tag ? list(init) : page([], false),
    "api/conversations/GetConversationDetails": (init: FetchInit) => ({
      hasMoreMessages: false,
      messages: [{ wmgId: `${bodyOf(init).id}-message`, body: "<p>Synthetic message</p>" }],
    }),
  });
}

const listCalls = (c: FakeClient, tag = 1) => c.calls
  .filter((x) => x.url.endsWith("GetConversationList") && bodyOf(x.init).tag === tag)
  .map((x) => bodyOf(x.init));

describe("conversation-list continuation", () => {
  test.each([1, 6, 7])("tag %i reaches older threads across an empty page and dedupes overlaps", async (tag) => {
    const pages = [page([recent, boundary], true, searched[0]), page([], true, searched[1], ""),
      page([{ ...boundary, subject: "Boundary duplicate" }, older], false)];
    const c = clientFor((init) => {
      const p = bodyOf(init).localLoadParams as Record<string, unknown>;
      if (p.loadEndInstantISO) return page([recent], true, searched[0]); // wrong direction shrinks to a subset
      if (!p.loadStartInstantISO) return pages[0];
      if (p.loadStartInstantISO === searched[0]) return pages[1];
      if (p.loadStartInstantISO === searched[1]) return pages[2];
      return page([recent], true, searched[0]);
    }, tag);
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);

    const index = sink.json("structured/messages/_threads_full_index.json");
    expect(index).toEqual([
      { ...recent, tag, full_msgs: 1, attachments: 0, attachments_saved: 0 },
      { ...boundary, tag, full_msgs: 1, attachments: 0, attachments_saved: 0 },
      { ...older, tag, full_msgs: 1, attachments: 0, attachments_saved: 0 },
    ]);
    expect(listCalls(c, tag).map((b) => b.localLoadParams)).toEqual(["", ...searched].map((cursor) => ({
      loadStartInstantISO: cursor, loadEndInstantISO: "", pagingInfo: 1,
    })));
    expect(listCalls(c, tag).every((b) => b.PageNonce === ctx.nonce && b.searchQuery === "")).toBe(true);
    expect(c.calls.filter((x) => x.url.endsWith("GetConversationDetails")).map((x) => bodyOf(x.init)))
      .toMatchObject([{ id: recent.hthId, organizationId: recent.organizationId },
        { id: boundary.hthId, organizationId: boundary.organizationId },
        { id: older.hthId, organizationId: older.organizationId }]);
    pages.forEach((p, i) => expect(sink.json(`structured/messages/list_tag${tag}${i ? `_p${i + 1}` : ""}.json`)).toEqual(p));
    expect(sink.text("structured/messages/threads_full/002_Older_example_m0.html")).toContain("Synthetic message");
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });

  test("an empty first page is not completion while the server reports more", async () => {
    const c = clientFor((init) => {
      const p = bodyOf(init).localLoadParams as Record<string, unknown>;
      return p.loadStartInstantISO === searched[0] ? page([older], false) : page([], true, searched[0], "");
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(listCalls(c)).toHaveLength(2);
    expect(sink.json("structured/messages/_threads_full_index.json")).toMatchObject([{ hthId: older.hthId }]);
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });

  test.each([undefined, ""])("missing/empty searched cursor (%s) retains data and reports incomplete", async (cursor) => {
    const c = clientFor(() => page([recent], true, cursor));
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(listCalls(c)).toHaveLength(1);
    expect(sink.json("structured/messages/_threads_full_index.json")).toMatchObject([{ hthId: recent.hthId }]);
    expect(summarizeGaps(ctx.manifest).concerns).toMatchObject([
      { outcome: "incomplete", note: expect.stringContaining("no continuation cursor") },
    ]);
  });

  test("a repeated page/cursor hits the existing bounded backstop without claiming completion", async () => {
    const c = clientFor(() => page([recent], true, searched[0]));
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(listCalls(c)).toHaveLength(6);
    expect(sink.json("structured/messages/_threads_full_index.json")).toHaveLength(1);
    expect(summarizeGaps(ctx.manifest).concerns).toMatchObject([
      { outcome: "incomplete", note: expect.stringContaining("5 consecutive pages added nothing new") },
    ]);
  });

  test("failed continuation retains earlier threads and records incomplete discovery", async () => {
    let requests = 0;
    const c = clientFor(() => ++requests === 1 ? page([recent], true, searched[0]) : "<html>Unavailable</html>");
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(listCalls(c)).toHaveLength(2);
    expect(sink.json("structured/messages/_threads_full_index.json")).toHaveLength(1);
    expect(sink.has("structured/messages/list_tag1_p2.json")).toBe(false);
    expect(summarizeGaps(ctx.manifest).concerns).toContainEqual(expect.objectContaining({
      outcome: "incomplete", note: expect.stringContaining("request for page 2 failed"),
    }));
  });

  test("a run abort preserves the raw first page and does not request more", async () => {
    const c = clientFor(() => {
      ctx.signal.aborted = true;
      ctx.signal.reason = "synthetic-stop";
      return page([recent], true, searched[0]);
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(listCalls(c)).toHaveLength(1);
    expect(sink.json("structured/messages/list_tag1.json")).toEqual(page([recent], true, searched[0]));
    expect(ctx.manifest.find((r) => r.endpoint === "GetConversationList[tag1][completeness]"))
      .toMatchObject({ outcome: "incomplete", note: expect.stringContaining("run stopped (synthetic-stop)") });
  });
});
