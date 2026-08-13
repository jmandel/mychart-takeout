/**
 * End-to-end proof: build the real console bundle, inject it into a real
 * headless Chromium page pointed at the mock MyChart, run the export in-page,
 * and verify the produced zip — the exact bookmarklet/console-paste path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { unzipSync } from "../../../packages/browser/src/zip";
import { buildBrowserBundle } from "../../../apps/web-build/bundle";
import { findChromium } from "../src/chromium";
import { startMockMyChart, type MockServer } from "../src/server";

const CHROMIUM = findChromium();
let mock: MockServer;
let browser: Browser | null = null;
let files: Record<string, Uint8Array> = {};
const dec = new TextDecoder();
const textOf = (rel: string) => {
  expect(files[rel], `missing ${rel} in zip`).toBeDefined();
  return dec.decode(files[rel]!);
};

beforeAll(async () => {
  if (!CHROMIUM) return; // no browser (e.g. CI without Chrome) — the suite is skipped
  mock = startMockMyChart({});
  const bundle = await buildBrowserBundle();
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[page]", m.text());
  });
  await page.goto(`${mock.url}/MyChart/Home`);
  await page.addScriptTag({ content: bundle });
  const zipB64 = await page.evaluate(async () => {
    const api = (globalThis as unknown as {
      __mychartExport: {
        run(o: { ccda: boolean; settleCapMs: number }): Promise<Uint8Array>;
      };
    }).__mychartExport;
    const bytes = await api.run({ ccda: true, settleCapMs: 50 });
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  files = unzipSync(new Uint8Array(Buffer.from(zipB64, "base64")));
}, 120_000);

afterAll(async () => {
  await browser?.close();
  mock?.stop();
});

describe.skipIf(!CHROMIUM)("in-browser export against mock MyChart", () => {
  test("structured SIMPLE + CLASSIC files", () => {
    expect(JSON.parse(textOf("structured/allergies/allergies__LoadAllergies.json")).dataList).toHaveLength(2);
    expect(textOf("structured/health-summary/health-summary__FetchHealthSummary.json")).toContain("Alex");
    expect(JSON.parse(textOf("structured/care-team/Clinical__CareTeam__Load.json")).careTeam).toHaveLength(1);
    expect(files["structured/insurance/Insurance__Coverages__GetCoverages.json"]).toBeDefined();
  });

  test("test results: list + iframe-harvested eorderid details", () => {
    expect(files["structured/test-results/GetList.json"]).toBeDefined();
    expect(JSON.parse(textOf("structured/test-results/_detail_links.json"))).toEqual(["EO1", "EO2"]);
    expect(JSON.parse(textOf("structured/test-results/details/00_CBC_With_Differential.json")).eorderid).toBe("EO1");
    expect(textOf("structured/test-results/details/01_MRI_Brain_w_o_contrast.json")).toContain("Normal study");
  });

  test("visits: pagination, AVS, notes", () => {
    expect(files["structured/visits/past_page_1.json"]).toBeDefined();
    expect(files["structured/visits/past_page_2.json"]).toBeDefined();
    expect(files["structured/visits/past_page_3.json"]).toBeUndefined();
    expect(JSON.parse(textOf("structured/visits/_all_csns.json"))).toEqual(["CSN1", "CSN2", "CSN3"]);
    expect(textOf("structured/visits/avs/00.html")).toContain("CSN1");
    expect(textOf("structured/visits/notes/00_0.html")).toContain("Progress Note");
    expect(files["structured/visits/visitnotes_meta/02.json"]).toBeDefined();
  });

  test("messages: threads with per-message HTML", () => {
    expect(textOf("structured/messages/threads_full/000_Lab_results_question.json")).toContain("TH1");
    expect(textOf("structured/messages/threads_full/000_Lab_results_question_m0.html")).toContain("lab results");
    expect(files["structured/messages/threads_full/000_Lab_results_question_m1.html"]).toBeDefined();
    expect(textOf("structured/messages/threads_full/001_Refill_request_m0.html")).toContain("Example Pharmacy");
    const idx = JSON.parse(textOf("structured/messages/_threads_full_index.json"));
    expect(idx).toHaveLength(2);
  });

  test("flowsheets: two pages, terminated by no-new-ISOs", () => {
    expect(files["structured/track-my-health/readings/00_Blood_Pressure_p0.json"]).toBeDefined();
    expect(files["structured/track-my-health/readings/00_Blood_Pressure_p1.json"]).toBeDefined();
    expect(files["structured/track-my-health/readings/00_Blood_Pressure_p2.json"]).toBeUndefined();
  });

  test("ccda: zip downloaded and extracted", () => {
    expect(files["documents/ccda/HealthSummary_all_visits_CCDA.zip"]).toBeDefined();
    expect(textOf("documents/ccda/extracted/IHE_XDM/SUBSET01/DOC0001.XML")).toContain("ClinicalDocument");
    expect(files["documents/ccda/extracted/IHE_XDM/SUBSET01/DOC0002.XML"]).toBeDefined();
  });

  test("dom snapshots via iframes", () => {
    expect(textOf("dom/test-results.html")).toContain("mock-section");
    expect(files["dom/insurance.txt"]).toBeDefined();
  });

  test("manifest + report layer", () => {
    const man = JSON.parse(textOf("_manifest.json"));
    expect(man.some((r: { domain: string }) => r.domain === "test-results")).toBe(true);
    const summary = textOf("PATIENT_SUMMARY.md");
    expect(summary).toContain("Alex");
    expect(summary).toContain("CBC With Differential");
    expect(textOf("indexes/test_result_components.csv")).toContain("WBC");
    const manifest = JSON.parse(textOf("MANIFEST.json"));
    expect(manifest.record_counts).toMatchObject({
      problems: 2,
      allergies: 2,
      immunizations: 2,
      medications: 2,
      test_result_orders: 2,
      encounters: 3,
      message_threads: 2,
      messages: 3,
    });
    expect(files["README.md"]).toBeDefined();
    expect(files["PATIENT_SUMMARY.json"]).toBeDefined();
  });
});
