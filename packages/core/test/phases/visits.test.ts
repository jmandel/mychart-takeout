import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { ALEX_PAST_PAGE_1, ALEX_PAST_PAGE_2, ALEX_UPCOMING } from "../fixtures/alex";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

function sidxOf(url: string): string {
  return /serializedIndex=([^&]*)/.exec(url)?.[1] ?? "";
}

function alexClient(): FakeClient {
  return new FakeClient({
    "Visits/VisitsList/LoadUpcoming": ALEX_UPCOMING,
    "Visits/VisitsList/LoadPast": (_init: FetchInit, url: string) =>
      sidxOf(url) === "" ? ALEX_PAST_PAGE_1 : ALEX_PAST_PAGE_2,
    "api/report-content/LoadReportContent": (init: FetchInit) => {
      const b = bodyOf(init);
      if (b.reportMnemonic === "AMB_AVS") {
        return b.csn === "CSN-1"
          ? { reportContent: "<p>AVS one</p>", reportCss: "body{color:black}" }
          : {};
      }
      // OPEN_NOTES
      return { reportContent: "<p>Progress note body</p>", reportCss: "" };
    },
    "api/visit-notes/GetVisitNotes": (init: FetchInit) => {
      const b = bodyOf(init);
      if (b.CSN === "CSN-1") {
        return {
          lrpID: "LRP1",
          noteList: [
            {
              hnoID: "H1",
              hnoDAT: "D1",
              displayName: "Progress Note",
              provider: "Dr. Fake Person",
              iso: "2025-07-01",
            },
          ],
        };
      }
      return {};
    },
  });
}

describe("visits phase", () => {
  test("paginates LoadPast until HasMoreData is false", async () => {
    const c = alexClient();
    const { ctx, sink } = makeTestCtx(c);
    await phases.visits(ctx);
    expect(sink.json("structured/visits/past_page_1.json")).toEqual(ALEX_PAST_PAGE_1);
    expect(sink.json("structured/visits/past_page_2.json")).toEqual(ALEX_PAST_PAGE_2);
    expect(sink.has("structured/visits/past_page_3.json")).toBe(false);
    expect(c.calls.filter((x) => x.url.includes("LoadPast")).length).toBe(2);
    // second page requested with the SerializedIndex from page 1
    const p2 = c.calls.filter((x) => x.url.includes("LoadPast"))[1]!;
    expect(sidxOf(p2.url)).toBe("IDX2");
  });

  test("collects CSNs from past pages + upcoming, writes AVS and notes", async () => {
    const { ctx, sink } = makeTestCtx(alexClient());
    await phases.visits(ctx);
    expect(sink.json("structured/visits/_all_csns.json")).toEqual(["CSN-1", "CSN-2", "CSN-UP"]);
    const avs = sink.text("structured/visits/avs/00.html");
    expect(avs).toContain("<!-- CSN CSN-1 | 7/1/2025 Office Visit Dr. Fake Person -->");
    expect(avs).toContain("<style>body{color:black}</style>");
    expect(avs).toContain("<p>AVS one</p>");
    expect(sink.has("structured/visits/avs/01.html")).toBe(false); // no AVS content for CSN-2
    const note = sink.text("structured/visits/notes/00_0.html");
    expect(note).toContain(
      "<!-- CSN CSN-1 | 7/1/2025 Office Visit Dr. Fake Person | Progress Note Dr. Fake Person 2025-07-01 -->",
    );
    expect(note).toContain("<p>Progress note body</p>");
    const vm = sink.json("structured/visits/visitnotes_meta/00.json") as {
      csn: string;
      resp: { lrpID: string };
    };
    expect(vm.csn).toBe("CSN-1");
    expect(vm.resp.lrpID).toBe("LRP1");
  });

  test("visit index + final manifest note count AVS and notes", async () => {
    const { ctx, sink } = makeTestCtx(alexClient());
    await phases.visits(ctx);
    const idx = sink.json("structured/visits/_visit_index.json") as Record<string, unknown>[];
    expect(idx).toHaveLength(3);
    expect(idx[0]).toMatchObject({ idx: 0, csn: "CSN-1", avs_bytes: 14, notes: 1 });
    expect((idx[0]!.meta as Record<string, unknown>).dept).toBe("Example Clinic A");
    expect((idx[1]!.meta as Record<string, unknown>).dept).toBe("Example Clinic B");
    const rec = ctx.manifest.find((m) => m.endpoint === "AVS+notes");
    expect(rec?.note).toBe("1 AVS, 1 notes");
  });

  test("OPEN_NOTES request carries lrpID + note context", async () => {
    const c = alexClient();
    const { ctx } = makeTestCtx(c);
    await phases.visits(ctx);
    const open = c.calls
      .filter((x) => x.url.endsWith("LoadReportContent"))
      .map((x) => bodyOf(x.init))
      .find((b) => b.reportMnemonic === "OPEN_NOTES")!;
    expect(open).toMatchObject({
      reportID: "LRP1",
      contextID: "H1",
      contextDAT: "D1",
      contextINI: "HNO",
      csn: "CSN-1",
    });
  });

  test("stops when SerializedIndex repeats", async () => {
    const c = new FakeClient({
      "Visits/VisitsList/LoadPast": { SerializedIndex: "SAME", A: { HasMoreData: true } },
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.visits(ctx);
    // page1: sidx "" → next SAME; page2: sidx SAME → next SAME === sidx → break
    expect(c.calls.filter((x) => x.url.includes("LoadPast")).length).toBe(2);
    expect(sink.has("structured/visits/past_page_2.json")).toBe(true);
    expect(sink.has("structured/visits/past_page_3.json")).toBe(false);
  });

  test("stops at the 60-page cap even when more data is advertised", async () => {
    let n = 0;
    const c = new FakeClient({
      "Visits/VisitsList/LoadPast": () => ({
        SerializedIndex: `IDX${++n}`,
        A: { HasMoreData: true },
      }),
    });
    const { ctx } = makeTestCtx(c);
    await phases.visits(ctx);
    expect(c.calls.filter((x) => x.url.includes("LoadPast")).length).toBe(61);
  });

  test("stops immediately on empty/non-JSON page (python falsy check)", async () => {
    const c = new FakeClient({ "Visits/VisitsList/LoadPast": {} });
    const { ctx, sink } = makeTestCtx(c);
    await phases.visits(ctx);
    expect(c.calls.filter((x) => x.url.includes("LoadPast")).length).toBe(1);
    expect(sink.has("structured/visits/past_page_1.json")).toBe(false);
  });
});
