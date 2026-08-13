import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

const LIST_KEY = "structured/documents/documents__viewer__LoadOtherDocuments.json";

describe("documents phase", () => {
  test("downloads bytes for docs with a token, saves detail, skips the rest — no crash", async () => {
    const c = new FakeClient({
      "api/documents/viewer/GetDocumentDetails": (init: FetchInit) => {
        const dcsId = bodyOf(init).dcsId;
        if (dcsId === "D1") return { dcsId: "D1", token: "T1", orgId: "", mimeType: "application/pdf" };
        if (dcsId === "D2") return { dcsId: "D2" }; // no token → metadata only
        return {};
      },
    });
    c.bytesRoutes.set("Documents/ViewDocument/DownloadOrStream", {
      status: 200,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
    });
    const { ctx, sink } = makeTestCtx(c);
    ctx.store.primeJson(LIST_KEY, {
      documents: [
        { dcsID: "D1", docExt: "PDF", docDesc: "Insurance Card", docType: "Insurance Card" },
        { dcsID: "D2", docExt: "TIF", docDesc: "Therapy Scan" },
        { docDesc: "no id at all" }, // no dcsID/docID → skipped
      ],
    });
    await phases.documents(ctx);

    expect(sink.has("documents/other/00_Insurance_Card_detail.json")).toBe(true);
    expect(sink.has("documents/other/00_Insurance_Card.pdf")).toBe(true); // token → bytes
    expect(sink.has("documents/other/01_Therapy_Scan_detail.json")).toBe(true);
    expect(sink.has("documents/other/01_Therapy_Scan.tif")).toBe(false); // no token → no bytes
    const rec = ctx.manifest.find((m) => m.endpoint === "content");
    expect(rec?.note).toContain("3 docs");
    expect(rec?.note).toContain("1 files downloaded");
  });

  test("no document list → records a gap, does not throw", async () => {
    const { ctx, sink } = makeTestCtx(new FakeClient({}));
    await phases.documents(ctx); // nothing primed
    expect(sink.has("documents/other/00_document_detail.json")).toBe(false);
    expect(ctx.manifest.some((m) => m.endpoint === "content" && /no other-documents/.test(m.note))).toBe(true);
  });

  test("a failed detail call for one doc doesn't abort the others", async () => {
    const c = new FakeClient({
      "api/documents/viewer/GetDocumentDetails": (init: FetchInit) => {
        if (bodyOf(init).dcsId === "BAD") throw new Error("boom");
        return { dcsId: "OK", token: "t", orgId: "" };
      },
    });
    c.bytesRoutes.set("Documents/ViewDocument/DownloadOrStream", { status: 200, bytes: new Uint8Array([1]) });
    const { ctx, sink } = makeTestCtx(c);
    ctx.store.primeJson(LIST_KEY, {
      documents: [{ dcsID: "BAD", docExt: "PDF" }, { dcsID: "OK", docExt: "PDF", docDesc: "good" }],
    });
    await phases.documents(ctx);
    expect(sink.has("documents/other/01_good.pdf")).toBe(true); // second still processed
  });
});
