/**
 * ACCEPTANCE SPEC for the verify-before-trust detection ladder.
 *
 * THESE TESTS ARE A SPECIFICATION, NOT A REGRESSION SUITE. They describe how
 * the exporter SHOULD behave against the hostile production instances we
 * debugged in the field (see tools/mock-mychart/src/server.ts MockOpts for the
 * impersonations). Some of them FAIL against the detection code as it stands —
 * that is the point: they are the target for the detection-ladder work.
 * DO NOT weaken an assertion to make it pass; make detection satisfy it.
 *
 * The three rules they encode, in one line each:
 *   1. Never trust a token you have not verified — a login page hands out
 *      __RequestVerificationToken inputs that authenticate nothing.
 *   2. Never spend a POST to answer "am I signed in?" — a wrong-token POST is
 *      what Epic's anti-CSRF defense kills the session over. Probe safely.
 *   3. Never barrage. One unverified attempt, then stop and say what happened.
 *
 * Everything is counted SERVER-SIDE (mock.stats()), so the tool cannot pass by
 * mis-reporting what it sent. Runs the real console bundle in headless
 * Chromium; auto-skips when no browser is present (same findChromium pattern
 * as the other e2e suites).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { unzipSync } from "../../../packages/browser/src/zip";
import { buildBrowserBundle } from "../../../apps/web-build/bundle";
import { findChromium } from "../src/chromium";
import { startMockMyChart, type MockOpts, type MockServer } from "../src/server";

const CHROMIUM = findChromium();
let browser: Browser | null = null;
let bundle = "";

beforeAll(async () => {
  if (!CHROMIUM) return; // no browser (e.g. CI without Chrome) — the suite is skipped
  bundle = await buildBrowserBundle();
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

/** Wait for the on-load detection to reach a terminal overlay state. The
 *  wording may change as detection evolves, so a timeout here is not a
 *  failure — the server-side counters are what the tests assert on. */
async function detectionSettled(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        // The panel renders inside a shadow root (page-CSS isolation), so the
        // host's textContent is empty — read through shadowRoot.
        const h = document.getElementById("__mychart_export_overlay");
        const t = h?.shadowRoot?.textContent ?? h?.textContent ?? "";
        return /Ready|isn't a signed-in|doesn't look like|don't appear to be signed in|Dismiss/.test(t);
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(250);
}

/**
 * Open `path` on the mock, optionally do something server-side while the tab
 * sits there (e.g. kill the session under it), then paste the bundle in — the
 * exact console/bookmarklet path — and let its on-load detection settle.
 */
async function openWithBundle(mock: MockServer, path: string, beforeInject?: () => void): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(`${mock.url}${path}`);
  beforeInject?.();
  await page.addScriptTag({ content: bundle });
  await detectionSettled(page);
  return page;
}

interface RunResult {
  /** "" when run() resolved (the tool believes it succeeded). */
  error: string;
  files: Record<string, Uint8Array>;
}

/** Click "Start export" the way a user would, and capture BOTH outcomes. */
async function runExport(page: Page, opts: Record<string, unknown> = {}): Promise<RunResult> {
  const r = await page.evaluate(async (o) => {
    const api = (globalThis as unknown as {
      __mychartExport: { run(o: Record<string, unknown>): Promise<Uint8Array> };
    }).__mychartExport;
    try {
      const bytes = await api.run(o);
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return { error: "", b64: btoa(s) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), b64: "" };
    }
  }, opts);
  return {
    error: r.error,
    files: r.b64 ? unzipSync(new Uint8Array(Buffer.from(r.b64, "base64"))) : {},
  };
}

const dec = new TextDecoder();
const textOf = (files: Record<string, Uint8Array>, rel: string): string => {
  expect(files[rel], `missing ${rel} in zip`).toBeDefined();
  return dec.decode(files[rel]!);
};

/** Fresh mock per scenario; always stopped. */
async function withMock(opts: MockOpts, fn: (mock: MockServer) => Promise<void>): Promise<void> {
  const mock = startMockMyChart(opts);
  try {
    await fn(mock);
  } finally {
    mock.stop();
  }
}

describe.skipIf(!CHROMIUM)("detection acceptance: hostile MyChart instances", () => {
  test(
    "PX build, signed in: resolves the prefix via the page token and exports real data",
    async () =>
      withMock({ px: true }, async (mock) => {
        const page = await openWithBundle(mock, "/MyChart/Home");
        const { error, files } = await runExport(page, { ccda: true, settleCapMs: 50 });

        expect(error).toBe("");
        expect(textOf(files, "structured/health-summary/health-summary__FetchHealthSummary.json")).toContain("Alex");
        expect(textOf(files, "PATIENT_SUMMARY.md")).toContain("Alex");
        expect(JSON.parse(textOf(files, "MANIFEST.json")).record_counts).toMatchObject({
          allergies: 2,
          encounters: 3,
          test_result_orders: 2,
          message_threads: 2,
        });

        const stats = mock.stats();
        expect(stats.apiPosts).toBeGreaterThan(10);
        // Every single call authenticated: the ladder never guessed a token.
        expect(stats.badTokenApiPosts).toBe(0);
        expect(stats.sessionAlive).toBe(true);
        await page.close();
      }),
    180_000,
  );

  test(
    "signed out (landed on the login page): fails cleanly, ZERO api POSTs",
    async () =>
      withMock({ px: true, signedIn: false }, async (mock) => {
        const page = await openWithBundle(mock, "/MyChart/Home");
        // Navigating a signed-out session lands on the ~100KB login page —
        // which carries a __RequestVerificationToken input. It must not be used.
        expect(page.url()).toContain("/Authentication/Login");

        const { error } = await runExport(page, { ccda: false });
        expect(error).toMatch(/signed-in MyChart page|not signed in|signed out/i);
        expect(mock.stats().apiPosts).toBe(0);
        expect(mock.stats().badTokenApiPosts).toBe(0);
        await page.close();
      }),
    120_000,
  );

  test(
    "session died under a live tab: fails cleanly, ZERO api POSTs (never spend a POST to find out)",
    async () =>
      withMock({ px: true }, async (mock) => {
        // The stale-tab case: the page (and its embedded token) loaded while the
        // session was live, then the session ended server-side. The token still
        // looks perfect. "Are we signed in?" is answerable with a safe GET —
        // a POST is never the right way to ask.
        const page = await openWithBundle(mock, "/MyChart/Home", () => mock.signOut("session timeout"));

        const { error } = await runExport(page, { ccda: false });
        expect(error).toMatch(/signed-in MyChart page|not signed in|signed out|authenticat/i);
        expect(mock.stats().apiPosts).toBe(0);
        await page.close();
      }),
    120_000,
  );

  test(
    "anti-CSRF instance with a stale first token: AT MOST ONE wrong-token POST, ever",
    async () =>
      withMock({ px: true, stalePageToken: true, killOnCsrfMismatch: true }, async (mock) => {
        // The destructive one. The page's FIRST __RequestVerificationToken is
        // stale; posting it makes Epic kill the session server-side, which is
        // why the field user kept getting "automatically signed out". One
        // unverified attempt is forgivable. Two is the bug.
        const page = await openWithBundle(mock, "/MyChart/Home");
        const { error, files } = await runExport(page, { ccda: false });

        const stats = mock.stats();
        expect(stats.badTokenApiPosts).toBeLessThanOrEqual(1);

        if (error === "") {
          // Acceptable outcome: the ladder tried the OTHER token in the page
          // and exported for real.
          expect(textOf(files, "structured/health-summary/health-summary__FetchHealthSummary.json")).toContain("Alex");
        } else {
          // Acceptable outcome: it stopped and said so — without a barrage of
          // calls into a session it had just killed.
          expect(error).toMatch(/signed-in MyChart page|signed out|session|authenticat/i);
          expect(stats.apiPosts).toBeLessThanOrEqual(3);
        }
        await page.close();
      }),
    120_000,
  );

  test(
    "live prefix alias: exports through the prefix that actually works, never the alias",
    async () =>
      withMock({ prefix: "/MyChartPRD", aliasPrefix: "/MyChart", px: true }, async (mock) => {
        // Entering through the alias, every page links back to it, and a POST
        // sent there is downgraded to a GET by the redirect chain — it "works"
        // and returns SPA shells forever.
        const page = await openWithBundle(mock, "/MyChart/Home");
        expect(page.url()).toContain("/MyChartPRD/Home");

        const { error, files } = await runExport(page, { ccda: false, settleCapMs: 50 });
        expect(error).toBe("");
        expect(textOf(files, "structured/health-summary/health-summary__FetchHealthSummary.json")).toContain("Alex");

        const stats = mock.stats();
        expect(stats.apiPosts).toBeGreaterThan(10);
        expect(stats.apiPostPaths.filter((p) => !p.startsWith("/MyChartPRD/api/"))).toEqual([]);
        await page.close();
      }),
    180_000,
  );

  test(
    "WAF interstitial in front of the API: not a live session, and not 40 calls into a challenge",
    async () =>
      withMock({ wafChallenge: true }, async (mock) => {
        // /Home/CSRFToken hands over a perfectly good token, but every api call
        // answers with a challenge page instead of JSON. A token that has not
        // returned JSON from a real endpoint is not a resolved session, and
        // walking the whole catalog into an edge challenge is how you get the
        // user's IP blocked.
        const page = await openWithBundle(mock, "/MyChart/Home");
        const { error } = await runExport(page, { ccda: false });

        expect(error).not.toBe("");
        expect(mock.stats().apiPosts).toBeLessThanOrEqual(3);
        await page.close();
      }),
    120_000,
  );
});
