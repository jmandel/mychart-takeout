/**
 * In-browser exporter entry (console paste / bookmarklet bundle).
 *
 * Runs the SAME core phases as the CDP CLI, with transport = the page's own
 * fetch and output = an in-memory zip the user downloads. There is no salvage
 * phase in browser mode: we only see our own requests (no passive network
 * log), and the iframe-based dom phase covers the pages whose JSON only
 * renders in-page. Screenshots are likewise CDP-only.
 */
import { buildReport, makeCtx, phases, renderGapsMd, summarizeGaps } from "@mychart/core";
import { BrowserClient, derivePrefix } from "./client";
import { FetchDom } from "./fetchDom";
import { exportFilename } from "./filename";
import { ensureOverlay } from "./overlay";
import { ZipSink } from "./zipSink";

export interface RunOpts {
  /** Also request/download the standards C-CDA package (async server-side). */
  ccda?: boolean;
  /** Capture per-section DOM snapshots via hidden iframes (default true). */
  dom?: boolean;
  /** Accepted for compatibility; ignored since the dom phase now fetches
   *  markup instead of waiting for a framed page to settle. */
  settleCapMs?: number;
}

async function run(opts: RunOpts = {}): Promise<Uint8Array> {
  const origin = location.origin;
  const prefix = derivePrefix(location.pathname);
  const overlay = ensureOverlay();
  overlay.setRunning();
  const log = (m: string) => {
    overlay.log(m);
    console.log(m);
  };

  const client = new BrowserClient(origin, prefix);
  const sink = new ZipSink();
  const ctx = makeCtx({
    client,
    sink,
    dom: new FetchDom(origin, prefix),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    log,
  });

  // Preflight: confirm we're actually signed in before doing anything, so a
  // click on a logged-out tab reports that instead of zipping login pages.
  const tok = await ctx.mc.token().catch(() => null);
  if (!tok || /\/Authentication\/Login|action=logout/i.test(location.href)) {
    const msg = "Not signed in to MyChart. Open your chart, sign in, then run again.";
    log(`!! ${msg}`);
    overlay.setDone(new Uint8Array());
    throw new Error(msg);
  }

  log(`Exporting from ${origin}${prefix} …`);
  const order: (keyof typeof phases)[] = [
    "structured",
    "testResults",
    "visits",
    "messages",
    "flowsheets",
    ...(opts.ccda ? (["ccda"] as const) : []),
    ...(opts.dom !== false ? (["dom"] as const) : []),
  ];
  for (const name of order) {
    try {
      await phases[name](ctx);
    } catch (e) {
      // Browser mode keeps going: one broken phase shouldn't lose the rest.
      ctx.log(`!! phase ${name} failed: ${e}`);
      ctx.rec("phase-error", name, null, String(e));
    }
  }
  await ctx.store.saveJson("_manifest.json", ctx.manifest);
  const gaps = summarizeGaps(ctx.manifest);
  await ctx.store.saveJson("gaps.json", gaps);
  await ctx.store.saveText("GAPS.md", renderGapsMd(gaps));
  log(`gaps: ${gaps.ok}/${gaps.attempted} ok, ${gaps.empty} empty, ${gaps.concerns.length} need attention`);
  try {
    await buildReport(ctx.store, {
      today: new Date().toISOString().slice(0, 10),
      source: `Epic MyChart (${location.host})`,
      method: "Authenticated MyChart internal JSON API via in-browser fetch (console/bookmarklet)",
      log,
    });
  } catch (e) {
    log(`!! report failed: ${e}`);
  }
  const hs = ctx.store.getJson("structured/health-summary/health-summary__FetchHealthSummary.json");
  const patient =
    hs && typeof hs === "object" && typeof (hs as { patientFirstName?: unknown }).patientFirstName === "string"
      ? (hs as { patientFirstName: string }).patientFirstName
      : undefined;
  const zip = sink.finalize();
  overlay.setDone(zip, exportFilename(location.host, patient));
  log(`Done: ${zip.length} bytes zipped${patient ? ` for ${patient}` : ""}.`);
  return zip;
}

declare global {
  // eslint-disable-next-line no-var
  var __mychartExport: { run(opts?: RunOpts): Promise<Uint8Array> } | undefined;
}

globalThis.__mychartExport = { run };

// Interactive path: show the overlay with a Start button (idempotent re-paste).
const overlay = ensureOverlay();
overlay.onStart(() => {
  void run().catch((e) => overlay.log(`!! export failed: ${e}`));
});
overlay.log("Ready. Click Start export (or call __mychartExport.run()).");
