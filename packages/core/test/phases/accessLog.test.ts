import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

describe("accessLog phase", () => {
  test("paginates portal via nextLineToParse, stops third-party on empty page", async () => {
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": (init: FetchInit) => {
        const start = bodyOf(init).startingLine;
        if (start === -1) return { entries: [{ accessor: "You" }], nextLineToParse: 50 };
        if (start === 50) return { entries: [{ accessor: "Dr. Chen" }], nextLineToParse: null };
        return { entries: [] };
      },
      "api/access-logs/GetThirdPartyAccessLogEntries": { entries: [], nextLineToParse: null },
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.accessLog(ctx);

    // portal walked two pages then stopped (null cursor)
    expect(sink.has("structured/access-log/portal_page_0.json")).toBe(true);
    expect(sink.has("structured/access-log/portal_page_1.json")).toBe(true);
    expect(sink.has("structured/access-log/portal_page_2.json")).toBe(false);
    // third-party: one empty page, no more
    expect(sink.has("structured/access-log/third-party_page_0.json")).toBe(true);
    expect(sink.has("structured/access-log/third-party_page_1.json")).toBe(false);
    // outcome recorded for both kinds (gaps report visibility)
    expect(ctx.manifest.some((m) => m.endpoint === "portal/GetEntries")).toBe(true);
    expect(ctx.manifest.some((m) => m.endpoint === "third-party/GetEntries")).toBe(true);
  });

  test("a repeated cursor is NOT the end: keeps paging until nextLineToParse is -1", async () => {
    // Observed live: the third-party log returns nextLineToParse 1 on every
    // page while serving new rows (635 pages); only -1 ends the list.
    let n = 0;
    const page = () => (++n < 5 ? { entries: [{ x: n }], nextLineToParse: 1 } : { entries: [{ x: n }], nextLineToParse: -1 });
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": () => ({ entries: [], nextLineToParse: -1 }),
      "api/access-logs/GetThirdPartyAccessLogEntries": page,
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.accessLog(ctx);
    expect(sink.keys("structured/access-log/third-party_page_").length).toBe(5);
    expect(ctx.manifest.some((m) => m.outcome === "incomplete")).toBe(false);
  });

  test("-1 ends the list — it is never sent back as a cursor (it would restart at page 1)", async () => {
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": () => ({ entries: [{ x: 1 }], nextLineToParse: -1 }),
      "api/access-logs/GetThirdPartyAccessLogEntries": () => ({ entries: [], nextLineToParse: -1 }),
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.accessLog(ctx);
    expect(sink.keys("structured/access-log/portal_page_").length).toBe(1);
  });

  test("a server that never ends and never reaches further back stops on the backstop and SAYS so", async () => {
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": () => ({ entries: [{ x: 1 }], nextLineToParse: 1 }),
      "api/access-logs/GetThirdPartyAccessLogEntries": () => ({ entries: [], nextLineToParse: -1 }),
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.accessLog(ctx);
    expect(sink.keys("structured/access-log/portal_page_").length).toBeLessThanOrEqual(11);
    const row = ctx.manifest.find((m) => m.endpoint === "portal/GetEntries[completeness]");
    expect(row?.outcome).toBe("incomplete");
  });

  test("keeps going while entries reach further back, even when some pages add nothing new", async () => {
    // Live: 6 of 635 third-party pages were all-duplicates mid-stream.
    let n = 0;
    const page = () => {
      n++;
      const day = n % 3 === 0 ? n - 1 : n; // every 3rd page repeats the previous day's entry
      const last = n === 40;
      return { entries: [{ d: day, accessTime: new Date(Date.UTC(2026, 0, 1) - day * 86_400_000).toISOString() }], nextLineToParse: last ? -1 : 1 };
    };
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": () => ({ entries: [], nextLineToParse: -1 }),
      "api/access-logs/GetThirdPartyAccessLogEntries": page,
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.accessLog(ctx);
    expect(sink.keys("structured/access-log/third-party_page_").length).toBe(40);
    expect(ctx.manifest.some((m) => m.outcome === "incomplete")).toBe(false);
  });

  test("Stop ends the list where it is and records it as stopped by the user", async () => {
    let n = 0;
    let stop = false;
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": () => {
        n++;
        if (n === 5) stop = true;
        return { entries: [{ accessTime: new Date(Date.UTC(2026, 0, 1) - n * 86_400_000).toISOString() }], nextLineToParse: 1 };
      },
      "api/access-logs/GetThirdPartyAccessLogEntries": () => ({ entries: [], nextLineToParse: -1 }),
    });
    const { ctx, sink } = makeTestCtx(c);
    ctx.stopRequested = () => stop;
    await phases.accessLog(ctx);
    expect(sink.keys("structured/access-log/portal_page_").length).toBe(5);
    expect(ctx.manifest.find((m) => m.endpoint === "portal/GetEntries[completeness]")?.note).toContain("stopped by you");
  });
});
