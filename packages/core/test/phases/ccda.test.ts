import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { phases } from "../../src/phases/index";
import { ALEX_RELEASE_RECORDS_READY } from "../fixtures/alex";
import { FakeClient, makeTestCtx } from "../fixtures/harness";

describe("ccda phase", () => {
  test("times out after 30 polls when generation never becomes ready", async () => {
    const c = new FakeClient({
      "api/requested-records/GetReleaseRecords": {},
      "api/record-download/GetDownloadStarted": {},
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.ccda(ctx);
    const polls = c.calls.filter((x) => x.url.endsWith("GetReleaseRecords"));
    expect(polls).toHaveLength(31); // 1 initial + 30 polls
    expect(c.calls.some((x) => x.url.endsWith("GetDownloadStarted"))).toBe(true);
    const rec = ctx.manifest.find((m) => m.domain === "ccda");
    expect(rec).toMatchObject({ status: 0, note: "generation not ready (timed out)" });
    expect(sink.keys("documents/")).toEqual([]);
  });

  test("downloads, saves, and extracts a ready package", async () => {
    const zip = zipSync({
      "IHE_XDM/SUBSET01/DOC0001.XML": strToU8("<ClinicalDocument/>"),
      "INDEX.HTM": strToU8("<html>index</html>"),
    });
    const c = new FakeClient({
      "api/requested-records/GetReleaseRecords": ALEX_RELEASE_RECORDS_READY,
    });
    c.bytesRoutes.set("Documents/Released/Download", { status: 200, bytes: zip });
    const { ctx, sink } = makeTestCtx(c);
    await phases.ccda(ctx);
    // no generation request needed
    expect(c.calls.some((x) => x.url.endsWith("GetDownloadStarted"))).toBe(false);
    // query carries the release record's ids
    expect(c.bytesCalls[0]).toBe(
      "/MyChart/Documents/Released/Download?releaseId=R1&docId=D1&downloadedFileName=AlexExample.zip",
    );
    expect(sink.bytes("documents/ccda/HealthSummary_all_visits_CCDA.zip")).toEqual(zip);
    expect(
      new TextDecoder().decode(sink.bytes("documents/ccda/extracted/IHE_XDM/SUBSET01/DOC0001.XML")),
    ).toBe("<ClinicalDocument/>");
    const rec = ctx.manifest.find((m) => m.domain === "ccda")!;
    expect(rec.status).toBe(200);
    expect(rec.note).toBe(`${zip.length} bytes, 1 C-CDA docs -> documents/ccda/`);
  });

  test("non-downloadable / wrong-type records are ignored", async () => {
    const c = new FakeClient({
      "api/requested-records/GetReleaseRecords": {
        data: {
          releases: [
            { releaseId: "R2", documentId: "D2", isDownloadable: "0", type: "VDT" },
            { releaseId: "R3", documentId: "D3", isDownloadable: "1", type: "OTHER" },
          ],
        },
      },
      "api/record-download/GetDownloadStarted": {},
    });
    const { ctx } = makeTestCtx(c);
    await phases.ccda(ctx);
    const rec = ctx.manifest.find((m) => m.domain === "ccda");
    expect(rec?.note).toBe("generation not ready (timed out)");
  });

  test("empty download body records the failure", async () => {
    const c = new FakeClient({
      "api/requested-records/GetReleaseRecords": ALEX_RELEASE_RECORDS_READY,
    });
    c.bytesRoutes.set("Documents/Released/Download", { status: 200, bytes: new Uint8Array() });
    const { ctx, sink } = makeTestCtx(c);
    await phases.ccda(ctx);
    const rec = ctx.manifest.find((m) => m.domain === "ccda");
    expect(rec?.note).toBe("empty response");
    expect(sink.keys("documents/")).toEqual([]);
  });
});
