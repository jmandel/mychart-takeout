import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { phases, summarizeGaps } from "@mychart/core";
import { FakeClient, makeTestCtx } from "../../core/test/fixtures/harness";
import { runBrowserPhases } from "../src/runPhases";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const budgets = { recordsMs: 100, accessLogMs: 100 };

/** Only unrelated record phases are stubbed. The access-log sweep, Mc guard,
 * saved pages and gaps classification all use their real implementations. */
function scenario(endAfter = Infinity) {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restores.push(() => clock.mockRestore());
  const c = new FakeClient();
  const { ctx, sink } = makeTestCtx(c);
  for (const name of Object.keys(phases) as (keyof typeof phases)[]) {
    if (name === "accessLog") continue;
    c.route(`api/synthetic/${name}`, { ok: true });
    const stub = spyOn(phases, name).mockImplementation(async (phaseCtx) => {
      await phaseCtx.mc.api(`api/synthetic/${name}`);
      await phaseCtx.store.saveJson(`synthetic/${name}.json`, { saved: true });
    });
    restores.push(() => stub.mockRestore());
  }
  c.route("api/access-logs/GetPortalAccessLogEntries", { entries: [], nextLineToParse: -1 });
  let pages = 0;
  c.route("api/access-logs/GetThirdPartyAccessLogEntries", () => {
    // The old order fails here: audit downloads must not precede records.
    expect(sink.has("synthetic/messages.json")).toBe(true);
    expect(sink.has("synthetic/documents.json")).toBe(true);
    now += 30;
    pages++;
    return { entries: [{ event: `synthetic-event-${pages}` }], nextLineToParse: pages >= endAfter ? -1 : 1 };
  });
  return { ctx, sink, c, advance: (ms: number) => { now += ms; }, pageCount: () => pages };
}

describe("browser phase budgets", () => {
  test("access logs finish beyond the records deadline with their own allowance", async () => {
    const s = scenario(3);
    const timings = await runBrowserPhases(s.ctx, { ccda: true, categories: { accessLog: true } }, (name) => {
      if (name === "structured") s.advance(90);
    }, budgets);
    expect(s.pageCount()).toBe(3);
    expect(s.sink.has("synthetic/ccda.json")).toBe(true);
    expect(timings.at(-1)?.phase).toBe("accessLog");
    expect(s.ctx.signal.aborted).toBe(false);
    expect(s.ctx.manifest.some((m) => m.outcome === "incomplete")).toBe(false);
  });

  test("a never-ending access log stops at its own deadline and preserves records", async () => {
    const s = scenario();
    const timings = await runBrowserPhases(s.ctx, { categories: { accessLog: true } }, (name) => {
      if (name === "structured") s.advance(90);
    }, budgets);
    expect(s.ctx.signal).toEqual({ aborted: true, reason: "run-deadline" });
    expect(s.pageCount()).toBe(4); // the in-flight fourth page is retained
    expect(s.sink.keys("structured/access-log/third-party_page_")).toHaveLength(4);
    expect(s.sink.has("synthetic/messages.json")).toBe(true);
    expect(s.sink.has("synthetic/documents.json")).toBe(true);
    expect(timings.at(-1)?.abortedDuring).toBe(true);
    const gaps = summarizeGaps(s.ctx.manifest, s.ctx.signal.reason);
    expect(gaps.concerns.some((c) => c.domain === "access-log" && c.outcome === "incomplete")).toBe(true);
  });

  test.each(["run-deadline", "circuit-open: synthetic failure", "api/synthetic/logout"])(
    "does not restart after %s and records remaining selected phases",
    async (reason) => {
      const s = scenario();
      await runBrowserPhases(s.ctx, { categories: { accessLog: true } }, (name) => {
        if (name === "messages") {
          s.ctx.signal.aborted = true;
          s.ctx.signal.reason = reason;
          s.ctx.health.consecutiveFailures = 8;
        }
      }, budgets);
      expect(s.pageCount()).toBe(0);
      expect(s.ctx.signal).toEqual({ aborted: true, reason });
      expect(s.ctx.health.consecutiveFailures).toBe(8);
      expect(s.ctx.health.deadlineAt).toBe(1100);
      expect(s.sink.has("synthetic/documents.json")).toBe(false);
      const gaps = summarizeGaps(s.ctx.manifest, reason);
      expect(gaps.skipped.map((p) => p.endpoint)).toEqual(["documents", "accessLog"]);
    },
  );

  test("the records budget still stops a slow primary phase", async () => {
    const s = scenario();
    await runBrowserPhases(s.ctx, { categories: { accessLog: true } }, (name) => {
      if (name === "visits") s.advance(101);
    }, budgets);
    expect(s.ctx.signal.reason).toBe("run-deadline");
    expect(s.pageCount()).toBe(0);
    expect(summarizeGaps(s.ctx.manifest).skipped.map((p) => p.endpoint))
      .toEqual(["flowsheets", "messages", "documents", "accessLog"]);
  });

  test("access logs are opt-in: a default export never starts them", async () => {
    const s = scenario();
    const timings = await runBrowserPhases(s.ctx, {}, () => {}, budgets);
    expect(timings.map((t) => t.phase)).not.toContain("accessLog");
    expect(s.pageCount()).toBe(0);
    expect(s.sink.has("synthetic/messages.json")).toBe(true);
    expect(s.ctx.manifest.some((m) => m.outcome === "skipped")).toBe(false);
  });

  test("a messages/documents selection never starts access logs", async () => {
    const s = scenario();
    await runBrowserPhases(s.ctx, { categories: { clinical: false } }, () => {}, budgets);
    expect(s.sink.has("synthetic/messages.json")).toBe(true);
    expect(s.sink.has("synthetic/documents.json")).toBe(true);
    expect(s.pageCount()).toBe(0);
    expect(s.ctx.manifest.some((m) => m.outcome === "skipped")).toBe(false);
  });
});
