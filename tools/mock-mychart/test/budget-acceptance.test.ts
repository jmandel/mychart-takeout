/** Real bundle and download UI, synthetic portal and accelerated clock only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "@mychart/core"; // resolve fflate before playwright (see integration.test.ts)
import { chromium, type Browser, type Page } from "playwright-core";
import { buildBrowserBundle } from "../../../apps/web-build/bundle";
import { unzipSync } from "../../../packages/browser/src/zip";
import { findChromium } from "../src/chromium";
import { startMockMyChart } from "../src/server";

const CHROMIUM = findChromium();
let browser: Browser | null = null;
let bundle = "";
const dec = new TextDecoder();

beforeAll(async () => {
  if (!CHROMIUM) return;
  bundle = await buildBrowserBundle();
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 60_000);
afterAll(async () => { await browser?.close(); }, 30_000);

async function withExport(
  mode: "complete" | "endless" | "stalled",
  check: (page: Page, files: Record<string, Uint8Array>) => Promise<void>,
  during?: (page: Page) => Promise<void>,
): Promise<void> {
  const mock = startMockMyChart({});
  // A fresh context per scenario, closed with it.
  const context = await browser!.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${mock.url}/MyChart/Home`);
    await page.evaluate((scenario) => {
      // Record phases consume 14 simulated minutes. Each audit page costs
      // another minute, without changing request timeout timers. Entries are
      // newest-first: each page reaches a day further back (progress), except
      // in "stalled", which repeats one entry forever.
      let now = Date.now();
      (window as unknown as { __realNow: () => number }).__realNow = Date.now.bind(Date);
      Date.now = () => now;
      const fetch = window.fetch.bind(window);
      let auditPages = 0;
      const simulatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname.endsWith("/api/test-results/GetList")) now += 14 * 60_000;
        if (url.pathname.endsWith("/api/access-logs/GetPortalAccessLogEntries")) {
          return Response.json({ entries: [], nextLineToParse: -1 });
        }
        if (url.pathname.endsWith("/api/access-logs/GetThirdPartyAccessLogEntries")) {
          now += 60_000;
          auditPages++;
          if (scenario === "endless") await new Promise((r) => setTimeout(r, 25)); // room to press Stop
          const day = scenario === "stalled" ? 1 : auditPages;
          return Response.json({
            entries: [{ event: `synthetic-event-${day}`, accessTime: new Date(Date.UTC(2026, 0, 1) - day * 86_400_000).toISOString() }],
            nextLineToParse: scenario === "complete" && auditPages === 30 ? -1 : 1,
          });
        }
        return fetch(input, init);
      };
      window.fetch = simulatedFetch as typeof window.fetch;
    }, mode);
    await page.addScriptTag({ content: bundle });
    const running = page.evaluate(async () => {
      const bytes = await globalThis.__mychartExport!.run({ categories: { accessLog: true } });
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      // Unfreeze the simulated clock: Playwright's own in-page polling relies
      // on it, and a frozen clock left later locator calls and close() hanging.
      Date.now = (window as unknown as { __realNow: () => number }).__realNow;
      return btoa(binary);
    });
    await during?.(page);
    const b64 = await running;
    await check(page, unzipSync(new Uint8Array(Buffer.from(b64, "base64"))));
  } finally {
    await context.close();
    mock.stop();
  }
}

function read(files: Record<string, Uint8Array>, path: string) {
  expect(files[path], `missing ${path}`).toBeDefined();
  return JSON.parse(dec.decode(files[path]!));
}

function expectRecords(files: Record<string, Uint8Array>) {
  expect(read(files, "structured/messages/_threads_full_index.json")).toHaveLength(2);
  expect(Object.keys(files).some((p) => p.startsWith("documents/other/") && p.endsWith(".pdf"))).toBe(true);
  expect(Object.keys(files).some((p) => p.startsWith("structured/messages/attachments/"))).toBe(true);
}

describe.skipIf(!CHROMIUM)("browser export time budgets", () => {
  test("a progressing access log has no time limit: 30 simulated minutes, still complete", async () => {
    await withExport("complete", async (page, files) => {
      expectRecords(files);
      const run = read(files, "_diagnostics/run.json");
      expect(run.stoppedEarly).toBeNull();
      expect(run.phaseTimings.at(-1).phase).toBe("accessLog");
      expect(run.timeBudgetsMs).toEqual({ recordsMs: 900_000, accessLogMs: 0 });
      expect(files["structured/access-log/third-party_page_29.json"]).toBeDefined();
      expect(read(files, "gaps.json").concerns.some((c: { outcome: string }) => c.outcome === "incomplete")).toBe(false);
      expect(await page.getByText("Done — safe to close.", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(0);
    });
  }, 60_000);

  test("Stop & download ends a long access log, keeps records, and labels the ZIP partial", async () => {
    await withExport(
      "endless",
      async (page, files) => {
        expectRecords(files);
        const run = read(files, "_diagnostics/run.json");
        expect(run.stoppedEarly).toBeNull(); // a user stop is not a run abort
        const gaps = read(files, "gaps.json");
        const row = gaps.concerns.find((c: { domain: string; outcome: string }) => c.domain === "access-log" && c.outcome === "incomplete");
        expect(row?.note).toContain("stopped by you");
        expect(await page.getByRole("alert").textContent()).toContain("you stopped the access-log download");
        // The warning must not take away the download: the partial-export
        // button is present and enabled. (No real download here — a pending
        // download artifact left Chromium hanging on close in the full suite.)
        const dl = page.getByRole("button", { name: /^Download partial export/ });
        expect(await dl.isEnabled()).toBe(true);
      },
      async (page) => {
        const stop = page.getByRole("button", { name: "Stop & download" });
        await stop.waitFor({ timeout: 20_000 });
        await page.waitForTimeout(300); // let a few pages land
        await stop.click();
      },
    );
  }, 60_000);

  test("an incomplete paging backstop is visible even without a global abort", async () => {
    await withExport("stalled", async (page, files) => {
      expectRecords(files);
      expect(read(files, "_diagnostics/run.json").stoppedEarly).toBeNull();
      expect(read(files, "gaps.json").concerns.some((c: { outcome: string }) => c.outcome === "incomplete")).toBe(true);
      // Read the overlay directly (as the detection suite does): Playwright's
      // role locators intermittently hung here under the full suite.
      const ui = await page.evaluate(() => {
        const root = document.getElementById("__mychart_export_overlay")?.shadowRoot;
        return {
          alert: root?.querySelector('[role="alert"]')?.textContent ?? null,
          buttons: [...(root?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? ""),
          text: root?.textContent ?? "",
        };
      });
      expect(ui.alert).toContain("Partial export");
      expect(ui.buttons.some((b) => b.startsWith("Download partial export"))).toBe(true);
      expect(ui.text).not.toContain("Done — safe to close.");
    });
  }, 60_000);
});
