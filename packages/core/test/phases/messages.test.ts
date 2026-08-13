import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { ALEX_CONV_TAG1, ALEX_THREAD_T1 } from "../fixtures/alex";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

function alexClient(): FakeClient {
  return new FakeClient({
    "api/conversations/GetFoldersList": { folders: [] },
    "api/conversations/GetOrganizations": { organizations: [] },
    "api/conversations/GetConversationList": (init: FetchInit) => {
      const tag = bodyOf(init).tag;
      if (tag === 1) return ALEX_CONV_TAG1;
      if (tag === 2) return { conversations: [{ hthId: "T1", subject: "dup ignored" }] };
      return { conversations: [] };
    },
    "api/conversations/GetConversationDetails": (init: FetchInit) => {
      const id = bodyOf(init).id;
      if (id === "T1") return ALEX_THREAD_T1;
      return "<html>shell</html>"; // T2 → non-JSON → full_msgs null
    },
  });
}

describe("messages phase", () => {
  test("saves folder/org lists and per-tag conversation lists", async () => {
    const { ctx, sink } = makeTestCtx(alexClient());
    await phases.messages(ctx);
    expect(sink.json("structured/messages/folders.json")).toEqual({ folders: [] });
    expect(sink.json("structured/messages/organizations.json")).toEqual({ organizations: [] });
    expect(sink.json("structured/messages/list_tag1.json")).toEqual(ALEX_CONV_TAG1);
    for (const t of [2, 3, 4, 5, 6]) {
      expect(sink.has(`structured/messages/list_tag${t}.json`)).toBe(true);
    }
  });

  test("dedupes threads across tags (first tag wins)", async () => {
    const { ctx, sink } = makeTestCtx(alexClient());
    await phases.messages(ctx);
    const idx = sink.json("structured/messages/_threads_full_index.json") as Record<
      string,
      unknown
    >[];
    expect(idx).toHaveLength(2);
    expect(idx[0]).toMatchObject({ hthId: "T1", subject: "Lab follow-up", tag: 1 });
  });

  test("writes thread JSON + per-message HTML with comment header", async () => {
    const { ctx, sink } = makeTestCtx(alexClient());
    await phases.messages(ctx);
    const thread = sink.json(
      "structured/messages/threads_full/000_Lab_follow_up.json",
    ) as Record<string, unknown>;
    expect(thread.detail).toEqual(ALEX_THREAD_T1);
    const m0 = sink.text("structured/messages/threads_full/000_Lab_follow_up_m0.html");
    expect(m0).toContain(
      '<!-- Lab follow-up | 2025-07-02T10:00:00 | author={"name":"Dr. Fake Person"} -->',
    );
    expect(m0).toContain("<p>Hello Alex, your results look fine.</p>");
    // empty-body message gets no HTML file but still counts in full_msgs
    expect(sink.has("structured/messages/threads_full/000_Lab_follow_up_m1.html")).toBe(false);
  });

  test("non-JSON details → full_msgs null, no thread file", async () => {
    const { ctx, sink } = makeTestCtx(alexClient());
    await phases.messages(ctx);
    const idx = sink.json("structured/messages/_threads_full_index.json") as Record<
      string,
      unknown
    >[];
    expect(idx[1]).toMatchObject({ hthId: "T2", full_msgs: null });
    expect(sink.keys("structured/messages/threads_full/001")).toEqual([]);
  });

  test("final manifest note counts threads and messages", async () => {
    const { ctx } = makeTestCtx(alexClient());
    await phases.messages(ctx);
    const rec = ctx.manifest.find((m) => m.endpoint === "GetConversationDetails");
    expect(rec?.note).toBe("2 threads, 2 messages");
  });
});
