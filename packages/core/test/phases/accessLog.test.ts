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

  test("stops on a repeated cursor (Epic's known quirk)", async () => {
    const c = new FakeClient({
      "api/access-logs/GetPortalAccessLogEntries": () => ({ entries: [{ x: 1 }], nextLineToParse: 1 }),
      "api/access-logs/GetThirdPartyAccessLogEntries": () => ({ entries: [{ x: 1 }], nextLineToParse: 1 }),
    });
    const { ctx, sink } = makeTestCtx(c);
    await phases.accessLog(ctx);
    // cursor -1 → 1, then 1 → 1 repeats: at most a couple of pages, never runaway
    expect(sink.keys("structured/access-log/portal_page_").length).toBeLessThanOrEqual(3);
  });
});
