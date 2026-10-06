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
afterAll(async () => { await browser?.close(); });

async function withExport(
  mode: "complete" | "deadline" | "stalled",
  check: (page: Page, files: Record<string, Uint8Array>) => Promise<void>,
): Promise<void> {
  const mock = startMockMyChart({});
  const page = await browser!.newPage();
  try {
    await page.goto(`${mock.url}/MyChart/Home`);
    await page.evaluate((scenario) => {
      // Record phases consume 14 simulated minutes. Each audit page costs
      // another minute, without sleeping or changing request timeout timers.
      let now = Date.now();
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
          return Response.json({
            entries: [{ event: scenario === "stalled" ? "same-synthetic-event" : `synthetic-event-${auditPages}` }],
            nextLineToParse: scenario === "complete" && auditPages === 3 ? -1 : 1,
          });
        }
        return fetch(input, init);
      };
      window.fetch = simulatedFetch as typeof window.fetch;
    }, mode);
    await page.addScriptTag({ content: bundle });
    const b64 = await page.evaluate(async () => {
      const bytes = await globalThis.__mychartExport!.run();
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    await check(page, unzipSync(new Uint8Array(Buffer.from(b64, "base64"))));
  } finally {
    await page.close();
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
  test("access logs can finish after the records budget while all downloads survive", async () => {
    await withExport("complete", async (page, files) => {
      expectRecords(files);
      const run = read(files, "_diagnostics/run.json");
      expect(run.stoppedEarly).toBeNull();
      expect(run.phaseTimings.at(-1).phase).toBe("accessLog");
      expect(run.timeBudgetsMs).toEqual({ recordsMs: 900_000, accessLogMs: 900_000 });
      expect(files["structured/access-log/third-party_page_2.json"]).toBeDefined();
      expect(read(files, "gaps.json").concerns.some((c: { outcome: string }) => c.outcome === "incomplete")).toBe(false);
      expect(await page.getByText("Done — safe to close.", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(0);
    });
  }, 60_000);

  test("an audit timeout keeps messages/documents and visibly offers a partial ZIP", async () => {
    await withExport("deadline", async (page, files) => {
      expectRecords(files);
      const run = read(files, "_diagnostics/run.json");
      expect(run.stoppedEarly).toBe("run-deadline");
      expect(run.phaseTimings.at(-1)).toMatchObject({ phase: "accessLog", abortedDuring: true });
      expect(Object.keys(files).filter((p) => p.startsWith("structured/access-log/third-party_page_"))).toHaveLength(16);
      const gaps = read(files, "gaps.json");
      expect(gaps.concerns.some((c: { domain: string; outcome: string }) => c.domain === "access-log" && c.outcome === "incomplete")).toBe(true);
      expect(await page.getByRole("alert").isVisible()).toBe(true);
      expect(await page.getByRole("alert").textContent()).toContain("Time limit reached during access log");
      expect(await page.getByText("Done — safe to close.", { exact: true }).count()).toBe(0);
      // The warning must not take away the actual download or change its data.
      const downloadEvent = page.waitForEvent("download");
      await page.getByRole("button", { name: /^Download partial export/ }).click();
      const download = await downloadEvent;
      const saved = unzipSync(new Uint8Array(await Bun.file((await download.path())!).arrayBuffer()));
      expect(Object.keys(saved).sort()).toEqual(Object.keys(files).sort());
      expect(read(saved, "_diagnostics/run.json").stoppedEarly).toBe("run-deadline");
    });
  }, 60_000);

  test("an incomplete paging backstop is visible even without a global abort", async () => {
    await withExport("stalled", async (page, files) => {
      expectRecords(files);
      expect(read(files, "_diagnostics/run.json").stoppedEarly).toBeNull();
      expect(read(files, "gaps.json").concerns.some((c: { outcome: string }) => c.outcome === "incomplete")).toBe(true);
      expect(await page.getByRole("alert").isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /^Download partial export/ }).isVisible()).toBe(true);
      expect(await page.getByText("Done — safe to close.", { exact: true }).count()).toBe(0);
    });
  }, 60_000);
});
