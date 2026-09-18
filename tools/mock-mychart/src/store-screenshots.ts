#!/usr/bin/env bun
/**
 * Chrome Web Store screenshots (1280×800), rendered from the REAL overlay
 * running against the mock — so they can't drift from the product. The page
 * behind it is a fictional portal ("Example Health", patient "Alex"): synthetic
 * data only, no real organization's branding.
 *
 *   bun tools/mock-mychart/src/store-screenshots.ts   →  dist/store/*.png
 */
import "@mychart/core"; // first — see test/extension.test.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildBrowserBundle } from "../../../apps/web-build/bundle";
import { findChromium } from "./chromium";
import { startMockMyChart } from "./server";

const PORTAL = `
<style>
  body{margin:0;font:16px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f3f6f9;color:#1b2733}
  .top{background:#0f5c8c;color:#fff;padding:18px 40px;display:flex;gap:28px;align-items:center}
  .top b{font-size:22px;margin-right:auto}.top span{opacity:.85}
  main{max-width:1000px;margin:32px 40px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
  h1{grid-column:1/-1;margin:0 0 4px;font-size:30px}
  .card{background:#fff;border:1px solid #dde4ea;border-radius:12px;padding:18px 22px}
  .card h2{margin:0 0 10px;font-size:18px;color:#0f5c8c}.card li{margin:4px 0}
  ul{margin:0;padding-left:20px}
</style>
<div class="top"><b>Example Health · MyChart</b><span>Visits</span><span>Messages</span><span>Test Results</span><span>Medications</span></div>
<main>
  <h1>Welcome, Alex!</h1>
  <div class="card"><h2>Test results</h2><ul><li>Lipid panel — new</li><li>Hemoglobin A1c</li><li>Complete blood count</li></ul></div>
  <div class="card"><h2>Upcoming visits</h2><ul><li>Primary care — Oct 12</li><li>Dermatology — Nov 3</li></ul></div>
  <div class="card"><h2>Messages</h2><ul><li>Re: refill request</li><li>Your after-visit summary</li></ul></div>
  <div class="card"><h2>Medications</h2><ul><li>Atorvastatin 20 mg</li><li>Lisinopril 10 mg</li></ul></div>
</main>`;

const exe = findChromium();
if (!exe) throw new Error("no Chromium found (set CHROMIUM_PATH)");
const out = join(import.meta.dir, "..", "..", "..", "dist", "store");
mkdirSync(out, { recursive: true });
const mock = startMockMyChart({ px: true });
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${mock.url}/MyChart/Home`);
  await page.evaluate((html) => document.body.insertAdjacentHTML("afterbegin", html), PORTAL);
  await page.evaluate(() => document.querySelectorAll("#mock-section, body > p").forEach((e) => e.remove()));
  await page.addScriptTag({ content: await buildBrowserBundle() });
  const start = page.getByRole("button", { name: "Export everything", exact: true });
  await start.waitFor();
  await page.screenshot({ path: join(out, "1-ready.png") });
  await page.getByRole("button", { name: /scan first/ }).click();
  await page.getByRole("button", { name: "Export selected" }).waitFor();
  await page.screenshot({ path: join(out, "2-choose.png") });
  await page.getByRole("button", { name: "Export selected" }).click();
  await page.getByRole("button", { name: /^Download / }).waitFor({ timeout: 120_000 });
  await page.screenshot({ path: join(out, "3-done.png") });
  console.log(`wrote ${out}/{1-ready,2-choose,3-done}.png`);
} finally {
  await browser.close();
  mock.stop();
}
