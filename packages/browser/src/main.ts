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
import { collectDebugReport } from "./debug";
import { pageToken, resolveMyChart } from "./detect";
import { installNetCapture } from "./netcapture";
import { FetchDom } from "./fetchDom";
import { exportFilename } from "./filename";
import {
  finish,
  likelyCulprit,
  markExportStarted,
  priorCrashedRun,
  startRun,
  step,
} from "./journal";
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
  const overlay = ensureOverlay();
  overlay.setRunning();
  const log = (m: string) => {
    overlay.log(m);
    console.log(m);
    step(m); // phase-level context in the persisted journal
  };

  // Resolve WHERE MyChart is (correct path prefix) and confirm we're signed in,
  // by probing candidate prefixes for a real CSRF token. Failing here reports
  // clearly instead of producing a fake "Done" with an empty download.
  const resolved = await resolveMyChart();
  if (!resolved) {
    const msg = `This isn't a signed-in MyChart page (${location.host}).\nOpen your MyChart portal, sign in, then run it there — or click Debug to make a report to share privately with Josh.`;
    log(`!! ${msg.replace(/\n/g, " ")}`);
    overlay.setError(msg);
    throw new Error(msg);
  }
  const { origin, prefix } = resolved;

  const client = new BrowserClient(origin, prefix);
  const sink = new ZipSink();
  const ctx = makeCtx({
    client,
    sink,
    dom: new FetchDom(origin, prefix),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    log,
  });

  log(`Exporting from ${origin}${prefix} …`);
  markExportStarted();
  const order: (keyof typeof phases)[] = [
    "structured",
    "testResults",
    "visits",
    "messages",
    "flowsheets",
    "accessLog",
    "documents",
    ...(opts.ccda ? (["ccda"] as const) : []),
    ...(opts.dom !== false ? (["dom"] as const) : []),
  ];
  for (const name of order) {
    if (ctx.signal.aborted) break; // logged out mid-run — stop, don't save shells
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
  if (ctx.signal.aborted) {
    log(`⚠ You were LOGGED OUT during the export (at: ${ctx.signal.reason}). Data is incomplete.`);
    log("   Click Debug (below) and send the report privately to Josh.");
    finish("logged-out", ctx.signal.reason);
  } else if (!patient) {
    // "Ran but empty" looks like success — surface it and point at Debug.
    log("⚠ No patient data was found — this export looks EMPTY.");
    log("   Click Debug (below) to make a report and share it privately with Josh.");
    finish("error", "no patient data");
  } else {
    finish("done");
  }
  return zip;
}

declare global {
  // eslint-disable-next-line no-var
  var __mychartExport: { run(opts?: RunOpts): Promise<Uint8Array> } | undefined;
}

// Patch fetch/XHR as early as possible so we can observe how the app itself
// authenticates its API calls (for the "app works, our fetches don't" case).
installNetCapture();

globalThis.__mychartExport = { run };

// Interactive path: show the overlay, but only reveal Start once we've
// confirmed this is a signed-in MyChart page — so the wrong page never offers
// a button that would just fail.
// Start this run's journal (startRun stashes any prior crashed run first) — so
// even the on-load detection probes are recorded, and a previous unfinished run
// is available to the Debug report.
startRun(location.host, derivePrefix(location.pathname));

const overlay = ensureOverlay();
overlay.onStart(() => {
  // run() sets its own error banner on a failed preflight; for anything else
  // that throws, surface it as an error state (not a stuck "Running…").
  void run().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    finish("error", msg);
    if (!/isn't a signed-in MyChart page|signed out of MyChart/i.test(msg)) {
      overlay.setError(`Export failed: ${msg}`);
    }
  });
});
// The Debug button works in any state — especially when detection fails.
overlay.onDebug(() => collectDebugReport());

// If a previous export in this tab didn't finish (it may have logged the user
// out and reloaded the tab), point them at Debug — the report includes that
// run's journal, whose last live request is the likely culprit. (No "recovery":
// these failures repeat, so restarting is as good as resuming, and Start is
// still there to try again.)
const crashed = priorCrashedRun();
if (crashed) {
  const culprit = likelyCulprit(crashed);
  overlay.log(
    `⚠ A previous export here didn't finish${culprit ? ` (last request: ${culprit})` : ""} — it may have logged you out.`,
  );
  overlay.log("   Click Debug to capture what happened (and Start to try again).");
}

void (async () => {
  const resolved = await resolveMyChart();
  if (!resolved) {
    // A token in the page but no working session = this IS MyChart, but our
    // requests aren't authenticating (they redirect to login) even though the
    // user appears signed in — a different problem than "wrong page".
    const looksLikeMyChart = pageToken() !== null;
    overlay.setError(
      looksLikeMyChart
        ? "This looks like MyChart, but our requests aren't authenticating — every call redirected to login even though you appear signed in.\n" +
            "Click any menu item in MyChart to make it load data, then click Debug — it captures how the app authenticates so we can match it."
        : `This isn't a signed-in MyChart page (${location.host}).\n` +
            "Open your MyChart portal, sign in, then run it there — or click Debug to make a report to share privately with Josh.",
    );
  } else {
    overlay.log(`Detected MyChart at ${resolved.origin}${resolved.prefix}.`);
    overlay.setReady();
  }
})();
