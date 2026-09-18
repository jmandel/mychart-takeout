/**
 * The Chrome extension, loaded for real in headless Chromium: its service
 * worker injects the bundle into every frame, and the bundle's frameRole()
 * makes exactly ONE frame speak up. The wrapper-portal case (MyChart iframed
 * from another origin) is the reason the extension exists.
 *
 * A toolbar click can't be automated, so the test calls the worker's inject()
 * directly and stands in for `activeTab` with localhost host permissions added
 * to a temp copy of the manifest. What the click's grant covers in real Chrome
 * is therefore NOT tested here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// FIRST, before playwright: whichever module resolves core's fflate first decides
// whether Bun finds it for the whole process (a resolver quirk with workspace
// symlinks) — this file may run first, so it must take the working path.
import "@mychart/core";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Frame, type Page, type Worker } from "playwright-core";
import { buildBrowserBundle } from "../../../apps/web-build/bundle";
import { findChromium } from "../src/chromium";
import { startMockMyChart, type MockServer } from "../src/server";

const CHROMIUM = findChromium();
const EXT_SRC = join(import.meta.dir, "..", "..", "..", "apps", "extension");
let tmp = "";
let context: BrowserContext | null = null;
let worker: Worker;
let mock: MockServer;
let wrapper: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!CHROMIUM) return;
  tmp = mkdtempSync(join(tmpdir(), "takeout-ext-"));
  const ext = join(tmp, "ext");
  cpSync(EXT_SRC, ext, { recursive: true });
  writeFileSync(join(ext, "takeout.js"), await buildBrowserBundle());
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://localhost/*", "http://127.0.0.1/*"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

  mock = startMockMyChart({ px: true });
  // The portal: another origin (127.0.0.1 vs the mock's localhost) framing MyChart.
  wrapper = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/signedin/"
        ? new Response(
            `<html><body>Portal<iframe src="${mock.url}/MyChart/Home" style="width:900px;height:600px"></iframe>` +
              `<iframe src="http://127.0.0.1:${wrapper.port}/ad"></iframe></body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        : new Response("<html><body>unrelated</body></html>", { headers: { "content-type": "text/html" } }),
  });

  context = await chromium.launchPersistentContext(join(tmp, "profile"), {
    executablePath: CHROMIUM,
    headless: false, // extensions need the new headless mode, passed as a flag
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}, 180_000);

afterAll(async () => {
  await context?.close();
  wrapper?.stop(true);
  mock?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** What the toolbar click does, minus the click. */
async function clickIcon(page: Page): Promise<void> {
  const url = page.url();
  await worker.evaluate(async (u) => {
    const g = globalThis as unknown as {
      chrome: { tabs: { query(q: object): Promise<{ id: number }[]> } };
      __inject(id: number): Promise<void>;
    };
    const [tab] = await g.chrome.tabs.query({ url: u });
    await g.__inject(tab!.id);
  }, url);
}

const overlayText = (f: Frame): Promise<string> =>
  f.evaluate(() => document.getElementById("__mychart_export_overlay")?.shadowRoot?.textContent ?? "");

describe.skipIf(!CHROMIUM)("chrome extension", () => {
  test("plain MyChart tab: one click → Ready, zero POSTs", async () => {
    const page = await context!.newPage();
    await page.goto(`${mock.url}/MyChart/Home`);
    const before = mock.stats().apiPosts;
    await clickIcon(page);
    await page.getByRole("button", { name: "Export everything", exact: true }).waitFor();
    expect(mock.stats().apiPosts).toBe(before);
    await page.close();
  }, 60_000);

  test("wrapper portal: the embedded MyChart frame takes over — no new tab", async () => {
    const page = await context!.newPage();
    await page.goto(`http://127.0.0.1:${wrapper.port}/signedin/`);
    await clickIcon(page);
    const inner = page.frames().find((f) => f.url().startsWith(mock.url))!;
    await inner.getByRole("button", { name: "Export everything", exact: true }).waitFor();
    // Top frame yields; the unrelated same-origin frame never spoke.
    await page.waitForFunction(() => !document.getElementById("__mychart_export_overlay"));
    for (const f of page.frames()) {
      if (f !== inner) expect(await overlayText(f)).toBe("");
    }
    expect(context!.pages().filter((p) => !p.isClosed())).toContain(page);

    // …and the export runs to Done from inside the frame.
    await inner.getByRole("button", { name: "Export everything", exact: true }).click();
    await inner.getByRole("button", { name: /^Download / }).waitFor({ timeout: 60_000 });
    await page.close();
  }, 120_000);

  test("not MyChart: top frame says so", async () => {
    const page = await context!.newPage();
    await page.goto(`http://127.0.0.1:${wrapper.port}/other`);
    await clickIcon(page);
    await page.waitForFunction(() =>
      /doesn't look like a MyChart page/.test(
        document.getElementById("__mychart_export_overlay")?.shadowRoot?.textContent ?? "",
      ),
    );
    await page.close();
  }, 60_000);
});
