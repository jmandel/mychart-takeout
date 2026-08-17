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

/** Serves one thread whose message carries attachments; records byte fetches. */
class AttachmentClient extends FakeClient {
  downloaded: string[] = [];
  constructor(attachments: unknown[]) {
    super({
      "api/conversations/GetFoldersList": { folders: [] },
      "api/conversations/GetOrganizations": { organizations: [] },
      "api/conversations/GetConversationList": (init: FetchInit) =>
        bodyOf(init).tag === 1
          ? { conversations: [{ hthId: "TA", subject: "Device check", organizationId: "ORG9" }] }
          : { conversations: [] },
      "api/conversations/GetConversationDetails": {
        messages: [{ body: "<p>report attached</p>", attachments }],
      },
      "api/documents/viewer/GetDocumentDetails": (init: FetchInit) => ({
        dcsId: bodyOf(init).dcsId,
        token: `tok-${bodyOf(init).dcsId}`,
        orgId: String(bodyOf(init).organizationId ?? ""),
      }),
    });
  }
  override async fetchBytes(pathOrUrl: string): Promise<{ status: number; bytes: Uint8Array }> {
    this.downloaded.push(pathOrUrl);
    return { status: 200, bytes: new Uint8Array(9) };
  }
}

describe("message attachments", () => {
  test("downloads DCS attachments via the ViewDocument flow, with org passed through", async () => {
    const c = new AttachmentClient([
      { DocumentId: "D9", FileDisplayName: "Device Report.pdf", FileExtensionWithoutDot: "pdf" },
    ]);
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(sink.has("structured/messages/attachments/000_Device_check_a0_Device_Report.pdf")).toBe(true);
    // detail request carried the attachment's id + the thread's organization
    const det = c.calls.find((x) => x.url.endsWith("GetDocumentDetails"))!;
    expect(bodyOf(det.init)).toMatchObject({ dcsId: "D9", organizationId: "ORG9" });
    expect(c.downloaded[0]).toContain("DownloadOrStream?dcsId=D9&token=tok-D9");
    const row = ctx.manifest.find((m) => m.endpoint === "attachments");
    expect(row?.note).toBe("1/1 attachments downloaded");
    const idx = sink.json("structured/messages/_threads_full_index.json") as Record<string, unknown>[];
    expect(idx[0]).toMatchObject({ attachments: 1, attachments_saved: 1 });
  });

  test("excluded dcsIds (selection card) skip the download and say so", async () => {
    const c = new AttachmentClient([
      { DocumentId: "D9", FileDisplayName: "Device Report.pdf", FileExtensionWithoutDot: "pdf" },
    ]);
    const { ctx, sink } = makeTestCtx(c, { excludeDocIds: new Set(["D9"]) });
    await phases.messages(ctx);
    expect(sink.keys("structured/messages/attachments/")).toEqual([]);
    expect(c.downloaded).toEqual([]);
    const row = ctx.manifest.find((m) => m.endpoint === "attachments");
    expect(row?.note).toBe("0/1 attachments downloaded, 1 excluded by user");
  });

  test("unrecognizable attachment shape → shape-mismatch naming its keys, no download", async () => {
    const c = new AttachmentClient([{ mysteryRef: "x", label: "??" }]);
    const { ctx, sink } = makeTestCtx(c);
    await phases.messages(ctx);
    expect(sink.keys("structured/messages/attachments/")).toEqual([]);
    const row = ctx.manifest.find((m) => m.outcome === "shape-mismatch");
    expect(row?.note).toContain("mysteryRef,label");
    expect(c.downloaded).toEqual([]);
  });
});

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
