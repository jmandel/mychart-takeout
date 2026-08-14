/**
 * End-to-end proof for the raw-CDP driver: launch OUR OWN headless Chromium
 * (never the user's :9222 browser), point a tab at the mock MyChart, attach
 * over raw CDP (Bun-native WebSocket), and run the full export pipeline the
 * same way apps/cli does. Verifies files on disk incl. netlog + salvage.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { buildReport, makeCtx, phases, type PhaseCtx } from "@mychart/core";
import { findChromium } from "../../../tools/mock-mychart/src/chromium";
import { startMockMyChart, type MockServer } from "../../../tools/mock-mychart/src/server";

const CHROMIUM = findChromium();
import { FsSink } from "../src/fsSink";
import { salvage } from "../src/salvage";
import { CdpSession } from "../src/session";
import { snapshot } from "../src/snapshot";

let mock: MockServer;
let proc: Subprocess<"ignore", "ignore", "pipe"> | null = null;
let session: CdpSession | null = null;
let outDir = "";
let profileDir = "";
let ctx: PhaseCtx;

/** Parse "DevTools listening on ws://127.0.0.1:PORT/..." from chromium stderr. */
async function launchChromium(startUrl: string): Promise<string> {
  profileDir = mkdtempSync(join(tmpdir(), "cdp-e2e-profile-"));
  proc = Bun.spawn(
    [
      CHROMIUM ?? "/usr/bin/chromium",
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      startUrl,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
    if (m) {
      void reader.cancel().catch(() => {});
      return m[1]!;
    }
  }
  throw new Error(`chromium never printed a DevTools endpoint; stderr:\n${buf.slice(0, 2000)}`);
}

/** Wait until the tab has actually navigated to the mock (not about:blank). */
async function waitForMyChartTab(httpEndpoint: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(new URL("/json/list", httpEndpoint))).json()) as {
        url: string;
      }[];
      if (list.some((t) => t.url.includes("/MyChart/"))) return;
    } catch {
      /* retry */
    }
    await Bun.sleep(200);
  }
  throw new Error("mock MyChart tab never appeared");
}

beforeAll(async () => {
  if (!CHROMIUM) return; // no browser (e.g. CI without Chrome) — the suite is skipped
  mock = startMockMyChart({});
  outDir = mkdtempSync(join(tmpdir(), "cdp-e2e-out-"));
  const wsUrl = await launchChromium(`${mock.url}/MyChart/Home`);
  const port = Number(new URL(wsUrl).port);
  expect(port).not.toBe(9222); // never the user's live browser
  const endpoint = `http://127.0.0.1:${port}`;
  await waitForMyChartTab(endpoint);

  session = await CdpSession.connect({ endpoint, out: outDir });
  ctx = makeCtx({
    client: session.client(),
    sink: new FsSink(outDir),
    timeZone: "UTC",
    log: () => {},
  });

  // mirror apps/cli runExport order
  await phases.structured(ctx);
  await phases.testResults(ctx);
  await phases.visits(ctx);
  await phases.messages(ctx);
  await phases.flowsheets(ctx);
  await phases.ccda(ctx);
  await snapshot(session.page, outDir, "final");
  salvage(outDir, session.origin);
  await ctx.store.saveJson("_manifest.json", ctx.manifest);
  await buildReport(ctx.store, { today: "2026-08-13" });
}, 240_000);

afterAll(async () => {
  await session?.close();
  proc?.kill();
  if (proc) await proc.exited;
  mock?.stop();
  if (process.env.MCT_KEEP_E2E_OUT) { console.log("kept:", outDir); return; }
  for (const d of [profileDir, outDir]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const read = (rel: string): string => readFileSync(join(outDir, rel), "utf-8");
const j = (rel: string): unknown => JSON.parse(read(rel));

describe.skipIf(!CHROMIUM)("raw-CDP end-to-end export against mock MyChart", () => {
  test("session derived origin/prefix from the live tab", () => {
    expect(session!.origin).toBe(mock.url);
    expect(session!.prefix).toBe("/MyChart");
  });

  test("structured SIMPLE + CLASSIC files", () => {
    const allergies = j("structured/allergies/allergies__LoadAllergies.json") as {
      dataList: unknown[];
    };
    expect(allergies.dataList).toHaveLength(2);
    expect(read("structured/health-summary/health-summary__FetchHealthSummary.json")).toContain("Alex");
    expect(existsSync(join(outDir, "structured/care-team/Clinical__CareTeam__Load.json"))).toBe(true);
  });

  test("test-results details keyed from the list payload", () => {
    expect(existsSync(join(outDir, "structured/test-results/GetList.json"))).toBe(true);
    const details = readdirSync(join(outDir, "structured/test-results/details")).sort();
    expect(details.length).toBeGreaterThanOrEqual(2);
    expect(details[0]).toMatch(/^00_/);
  });

  test("visits: both pages + AVS + notes", () => {
    expect(existsSync(join(outDir, "structured/visits/past_page_1.json"))).toBe(true);
    expect(existsSync(join(outDir, "structured/visits/past_page_2.json"))).toBe(true);
    expect(read("structured/visits/avs/00.html")).toContain("CSN");
    expect(readdirSync(join(outDir, "structured/visits/notes")).length).toBeGreaterThan(0);
  });

  test("messages: thread JSON + per-message html", () => {
    const files = readdirSync(join(outDir, "structured/messages/threads_full"));
    expect(files.some((f) => /^000_.*\.json$/.test(f))).toBe(true);
    expect(files.some((f) => /_m0\.html$/.test(f))).toBe(true);
  });

  test("flowsheets readings", () => {
    expect(readdirSync(join(outDir, "structured/track-my-health/readings")).length).toBeGreaterThan(0);
  });

  test("ccda zip downloaded and extracted", () => {
    expect(existsSync(join(outDir, "documents/ccda/HealthSummary_all_visits_CCDA.zip"))).toBe(true);
    // IHE-XDM zips nest docs (IHE_XDM/SUBSET01/DOC0001.XML) — walk recursively
    const xmls: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        if (name.isDirectory()) walk(join(d, name.name));
        else if (name.name.toUpperCase().endsWith(".XML")) xmls.push(name.name);
      }
    };
    walk(join(outDir, "documents/ccda/extracted"));
    expect(xmls.length).toBeGreaterThanOrEqual(2);
  });

  test("snapshot(): html/txt/meta + real captureScreenshot png", () => {
    expect(existsSync(join(outDir, "dom/final.html"))).toBe(true);
    const png = readFileSync(join(outDir, "screenshots/final.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  test("netlog captured the in-page API traffic with bodies", () => {
    const lines = read("raw_network/responses.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const apiHits = lines.filter(
      (r) => r.event === "response" && String(r.url).includes("/MyChart/api/") && r.body_file,
    );
    expect(apiHits.length).toBeGreaterThan(5);
    expect(readdirSync(join(outDir, "raw_network/bodies")).length).toBeGreaterThan(5);
  });

  test("salvage recovered endpoint bodies from the netlog", () => {
    const files = readdirSync(join(outDir, "structured/_captured_from_navigation"));
    expect(files.length).toBeGreaterThan(0);
  });

  test("report: summary + manifest record counts", () => {
    expect(read("PATIENT_SUMMARY.md")).toContain("Alex");
    const manifest = j("MANIFEST.json") as { record_counts: Record<string, number> };
    expect(manifest.record_counts.encounters).toBe(3);
    expect(manifest.record_counts.message_threads).toBe(2);
    expect(manifest.record_counts.test_result_orders).toBe(2);
  });
});
