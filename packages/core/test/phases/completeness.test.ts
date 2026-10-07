/**
 * Completeness rules (paging.ts) per phase, each grounded in a live-portal
 * observation from Oct 2026: a list is complete only when the server says so,
 * and every other stop shows up as an `incomplete` gap.
 */
import { describe, expect, test } from "bun:test";
import { summarizeGaps } from "../../src/gaps";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

const group = (key: string, organizationID = "LOCAL") => ({ key, resultList: [key], organizationID });

describe("test results: GetList pagination", () => {
  // Three pages; the continuation is groupBy → groupType + lastGroupKeys,
  // and page 2 advances only one of two organizations.
  function pagedClient(details: (b: Record<string, unknown>) => unknown = () => ({ orderName: "X", results: [{ name: "X" }] })) {
    return new FakeClient({
      "api/test-results/GetList": (init: FetchInit) => {
        const b = bodyOf(init);
        const k = b.lastGroupKeys as Record<string, string> | undefined;
        if (!k) return { groupBy: "ORDER", areResultsFullyLoaded: false, isGroupingFullyLoaded: false,
          organizationLoadMoreInfo: { A: { lastGroupKey: "a1" }, B: { lastGroupKey: "b1" } },
          newResultGroups: [group("o1"), group("o2", "EXT")] };
        expect(b.groupType).toBe("ORDER");
        if (k.A === "a1") return { groupBy: "ORDER", areResultsFullyLoaded: false, isGroupingFullyLoaded: false,
          organizationLoadMoreInfo: { A: { lastGroupKey: "a2" } }, newResultGroups: [group("o2", "EXT"), group("o3")] };
        expect(k).toEqual({ A: "a2", B: "b1" }); // B's position retained
        return { groupBy: "ORDER", areResultsFullyLoaded: true, isGroupingFullyLoaded: true,
          organizationLoadMoreInfo: {}, newResultGroups: [group("o4")] };
      },
      "api/test-results/GetDetails": (init: FetchInit) => details(bodyOf(init)),
    });
  }

  test("follows continuation until both flags are true; dedupes across pages", async () => {
    const c = pagedClient();
    const { ctx, sink } = makeTestCtx(c);
    await phases.testResults(ctx);
    expect(c.calls.filter((x) => x.url.includes("GetList")).length).toBe(3);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual(["o1", "o2", "o3", "o4"]);
    expect(sink.has("structured/test-results/GetList_page_3.json")).toBe(true);
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });

  test("details ask with organizationID \"\" first; the group's org only as a fallback", async () => {
    // Live: the group's organizationID returned an EMPTY detail for local orders.
    const asked: string[] = [];
    const c = pagedClient((b) => {
      asked.push(`${b.orderKey}:${b.organizationID}`);
      if (b.orderKey === "o2" && b.organizationID === "") return {}; // outside org needs its id
      return { orderName: "X", results: [{ name: "X" }] };
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.testResults(ctx);
    expect(asked).toEqual(["o1:", "o2:", "o2:EXT", "o3:", "o4:"]);
    expect(sink.keys("structured/test-results/details/").length).toBe(4);
  });

  test("more reported but no usable continuation → incomplete, never silent", async () => {
    const c = new FakeClient({
      "api/test-results/GetList": { groupBy: "ORDER", areResultsFullyLoaded: false, isGroupingFullyLoaded: false,
        organizationLoadMoreInfo: {}, newResultGroups: [group("o1")] },
      "api/test-results/GetDetails": { orderName: "X", results: [] },
    });
    const { ctx } = makeTestCtx(c);
    await phases.testResults(ctx);
    const row = ctx.manifest.find((m) => m.endpoint === "GetList[completeness]");
    expect(row?.outcome).toBe("incomplete");
    expect(summarizeGaps(ctx.manifest).concerns.some((x) => x.outcome === "incomplete")).toBe(true);
  });
});

describe("messages: every folder, every message", () => {
  const thread = (id: string, n: number, more = false) => ({
    hthId: id, subject: id, hasMoreMessages: more,
    messages: Array.from({ length: n }, (_, i) => ({ wmgId: `${id}-m${i + 10}`, deliveryInstantISO: `2026-01-${String(i + 10).padStart(2, "0")}T00:00:00Z`, body: "b" })),
  });

  test("lists every tag GetFoldersList reports (tag 7 held 16 conversations live)", async () => {
    const c = new FakeClient({
      "api/conversations/GetFoldersList": { folders: [{ tag: 1 }, { tag: 7 }] },
      "api/conversations/GetOrganizations": {},
      "api/conversations/GetConversationList": (init: FetchInit) =>
        bodyOf(init).tag === 7 ? { conversations: [{ hthId: "T7", subject: "s" }] } : { conversations: [] },
      "api/conversations/GetConversationDetails": () => thread("T7", 1),
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(c.calls.filter((x) => x.url.includes("GetConversationList")).map((x) => bodyOf(x.init).tag)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const index = sink.json("structured/messages/_threads_full_index.json") as { hthId: string; tag: number }[];
    expect(index.map((x) => [x.hthId, x.tag])).toEqual([["T7", 7]]);
  });

  test("asks for all messages, then pages older ones while hasMoreMessages", async () => {
    const c = new FakeClient({
      "api/conversations/GetFoldersList": { folders: [] },
      "api/conversations/GetOrganizations": {},
      "api/conversations/GetConversationList": (init: FetchInit) =>
        bodyOf(init).tag === 1 ? { conversations: [{ hthId: "T", subject: "s" }] } : { conversations: [] },
      "api/conversations/GetConversationDetails": (init: FetchInit) => {
        expect(bodyOf(init).maxReadMessages).toBe(9999);
        return thread("T", 3, true); // server still reports more
      },
      "api/conversations/GetConversationMessages": (init: FetchInit) => {
        expect(bodyOf(init).startInstantISO).toBe("2026-01-10T00:00:00Z"); // oldest loaded
        return { hasMoreMessages: false, messages: [
          { wmgId: "T-m1", deliveryInstantISO: "2026-01-01T00:00:00Z", body: "old" },
          { wmgId: "T-m10", deliveryInstantISO: "2026-01-10T00:00:00Z", body: "b" }, // overlap
        ] };
      },
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    const saved = sink.json(sink.keys("structured/messages/threads_full/").find((k) => k.endsWith(".json"))!) as {
      detail: { messages: { wmgId: string }[]; hasMoreMessages: boolean };
    };
    expect(saved.detail.messages.map((m) => m.wmgId)).toEqual(["T-m1", "T-m10", "T-m11", "T-m12"]); // oldest-first
    expect(saved.detail.hasMoreMessages).toBe(false);
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });
});

describe("flowsheets: a bound reached is reported", () => {
  test("readings that never run out → incomplete row", async () => {
    let n = 0;
    const c = new FakeClient({
      "api/track-my-health/GetFlowsheetReadings": () => {
        n++;
        const d = new Date(Date.UTC(2026, 0, 1) - n * 86400_000).toISOString().slice(0, 19);
        return { readings: [{ instant: d }] };
      },
    });
    const { ctx } = makeTestCtx(c);
    await ctx.store.saveJson("structured/track-my-health/track-my-health__GetFlowsheets.json", { flowsheets: [{ episodeId: "E", name: "BP" }] });
    await phases.flowsheets(ctx);
    expect(ctx.manifest.find((m) => m.endpoint === "GetFlowsheetReadings[00]")?.outcome).toBe("incomplete");
  });
});

describe("messages: conversation lists page the way the portal does", () => {
  // 9 local conversations, newest first, served 3 at a time from the window
  // that starts at loadStartInstantISO (older than it), as the portal's own
  // message center requests them; one outside org with 2 of its own.
  const at = (i: number) => new Date(Date.UTC(2026, 0, 30 - i)).toISOString();
  const local = Array.from({ length: 9 }, (_, i) => ({ hthId: `L${i}`, subject: `l${i}`, t: at(i) }));
  const ext = [{ hthId: "X0", subject: "x0", t: at(2), organizationId: "EXT" }, { hthId: "X1", subject: "x1", t: at(20), organizationId: "EXT" }];
  const page = (all: { t: string }[], start: string | undefined, n: number) => {
    const older = all.filter((c) => !start || c.t < start).slice(0, n);
    const oldest = older.at(-1)?.t ?? start ?? "";
    return { list: older, summary: { hasMoreConversations: all.filter((c) => !start || c.t < start).length > n, oldestLoadedInstantISO: oldest, oldestSearchedInstantISO: "1999-01-01T00:00:00.000Z", pagingInfo: 2, numberLoaded: older.length } };
  };

  test("next window starts at the oldest loaded so far; outside orgs paged via externalLoadParams", async () => {
    const bodies: Record<string, unknown>[] = [];
    const c = new FakeClient({
      "api/conversations/GetFoldersList": { folders: [] },
      "api/conversations/GetOrganizations": { organizations: {
        a: { organizationId: "LOCAL", isLocal: true, hasCommunicationCenter: true, hasInbox: true },
        b: { organizationId: "EXT", isLocal: false, hasCommunicationCenter: true, hasInbox: true },
      } },
      "api/conversations/GetConversationList": (init: FetchInit) => {
        const b = bodyOf(init);
        if (b.tag !== 1) return { conversations: [], localSummary: { hasMoreConversations: false } };
        bodies.push(b);
        const lp = b.localLoadParams as Record<string, unknown> | undefined;
        const ep = ((b.externalLoadParams as Record<string, Record<string, Record<string, unknown> | undefined>>).EXT ?? {}).communicationCenter;
        const l = lp ? page(local, lp.loadStartInstantISO as string, 3) : null;
        const e = ep ? page(ext, ep.loadStartInstantISO as string, 1) : null;
        return {
          conversations: [...(l?.list ?? []), ...(e?.list ?? [])],
          localSummary: l?.summary ?? { hasMoreConversations: false },
          externalSummaries: e ? { EXT: { communicationCenter: e.summary } } : {},
        };
      },
      "api/conversations/GetConversationDetails": (init: FetchInit) => ({ hthId: bodyOf(init).id, messages: [] }),
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    const index = sink.json("structured/messages/_threads_full_index.json") as { hthId: string }[];
    expect(index.map((x) => x.hthId).sort()).toEqual([...local.map((x) => x.hthId), "X0", "X1"].sort());
    // First request: empty window, pagingInfo 1, the outside org included; never numberToLoad.
    expect(bodies[0]!.localLoadParams).toEqual({ loadStartInstantISO: "", loadEndInstantISO: "", pagingInfo: 1 });
    expect((bodies[0]!.externalLoadParams as Record<string, unknown>).EXT).toBeDefined();
    expect(JSON.stringify(bodies)).not.toContain("numberToLoad");
    // Second request: starts at the oldest LOADED (not "searched"), pagingInfo carried forward.
    expect(bodies[1]!.localLoadParams).toEqual({ loadStartInstantISO: at(2), loadEndInstantISO: "", pagingInfo: 2 });
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });
});
