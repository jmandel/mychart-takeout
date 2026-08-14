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
import { BUILD } from "./buildInfo";
import { BrowserClient, derivePrefix } from "./client";
import { collectDebugReport } from "./debug";
import { cookiesAreLive, ladderTranscript, pageToken, preflightMyChart, resolveMyChart, resolvedMyChart } from "./detect";
import { capturedRequests, installNetCapture, observedApiPaths, resourceApiEntries } from "./netcapture";
import { FetchDom } from "./fetchDom";
import { exportFilename } from "./filename";
import {
  currentJournal,
  finish,
  formatJournal,
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
  // A retry after a completed run reuses the memoized resolution; a session
  // that idled out since must not receive its first POST blind — one cheap GET
  // re-check catches that. (A fresh resolution does its own liveness GET.)
  if (resolvedMyChart() && !(await cookiesAreLive())) {
    const msg =
      "You've been signed out of MyChart since this page loaded.\nSign in again in this tab, then click Start export.";
    log(`!! ${msg.replace(/\n/g, " ")}`);
    overlay.setError(msg);
    throw new Error(msg);
  }
  // First Start click runs the full verify ladder (page load only did GETs).
  const resolved = await resolveMyChart();
  if (!resolved) {
    const msg = pageToken()
      ? "This looks like MyChart, but none of our credential candidates authenticated — every verification bounced to login.\n" +
        "If MyChart now shows you signed out, that was its anti-CSRF defense reacting to our attempt. Sign in again, " +
        "click any MyChart menu item, then click Debug and share the report privately with Josh."
      : `This isn't a signed-in MyChart page (${location.host}).\nOpen your MyChart portal, sign in, then run it there — or click Debug to make a report to share privately with Josh.`;
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
    // The ladder already verified this token with a real API call — seed it so
    // the run never refetches an unverified one from a different source.
    initialToken: resolved.token,
    // Hard wall-clock backstop: slow-but-not-timing-out instances must not
    // grind for hours; past this, remaining calls record as skipped.
    runBudgetMs: 15 * 60_000,
    observedApiPaths,
  });

  log(`Exporting from ${origin}${prefix} (token via ${resolved.source}, build ${BUILD}) …`);
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
  const phaseTimings: { phase: string; ms: number; abortedDuring: boolean }[] = [];
  for (const name of order) {
    if (ctx.signal.aborted) break; // logged out mid-run — stop, don't save shells
    const t0 = Date.now();
    try {
      await phases[name](ctx);
    } catch (e) {
      // Browser mode keeps going: one broken phase shouldn't lose the rest.
      ctx.log(`!! phase ${name} failed: ${e}`);
      ctx.rec("phase-error", name, null, String(e));
    } finally {
      phaseTimings.push({ phase: name, ms: Date.now() - t0, abortedDuring: ctx.signal.aborted });
    }
  }
  await ctx.store.saveJson("_manifest.json", ctx.manifest);
  const gaps = summarizeGaps(ctx.manifest, ctx.signal.aborted ? ctx.signal.reason : undefined);
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
  // Every zip carries its own evidence: a failed or empty export IS the debug
  // bundle — one artifact to send, no separate report-collection step.
  try {
    const j = currentJournal();
    await ctx.store.saveText("_diagnostics/journal.txt", j ? formatJournal(j) : "(no journal)");
    await ctx.store.saveJson("_diagnostics/run.json", {
      build: BUILD,
      page: { host: location.host, prefix },
      tokenSource: resolved.source,
      detectionLadder: ladderTranscript(),
      phaseTimings,
      stoppedEarly: ctx.signal.aborted ? ctx.signal.reason : null,
      observedApiRequests: capturedRequests(),
      resourceTiming: resourceApiEntries(),
    });
  } catch (e) {
    log(`!! diagnostics failed: ${e}`);
  }
  const zip = sink.finalize();
  overlay.setDone(zip, exportFilename(location.host, patient));
  log(`Done: ${zip.length} bytes zipped${patient ? ` for ${patient}` : ""}.`);
  if (ctx.signal.aborted) {
    const r = ctx.signal.reason;
    if (/^circuit-open/.test(r)) {
      log(`⚠ Export stopped early — repeated failures (${r}). Data is incomplete.`);
    } else if (r === "run-deadline") {
      log("⚠ Export stopped early — it hit its time budget. Data is incomplete.");
    } else {
      log(`⚠ You were LOGGED OUT during the export (at: ${r}). Data is incomplete.`);
    }
    log("   The zip includes _diagnostics/ — send it (or a Debug report) privately to Josh.");
    finish(/^circuit-open|^run-deadline/.test(r) ? "error" : "logged-out", r);
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

// GET-only preflight: show Start when this looks like a signed-in MyChart
// page, without sending a single POST. Verification — the part that can trip
// Epic's anti-CSRF session kill — waits for the user's explicit Start click,
// so merely loading the bookmarklet can never sign anyone out.
void (async () => {
  const state = await preflightMyChart();
  if (state === "likely") {
    overlay.log(`This looks like a signed-in MyChart page (${location.host}).`);
    overlay.setReady();
  } else if (state === "signed-out") {
    overlay.setError(
      `You don't appear to be signed in to MyChart (${location.host}).\n` +
        "Sign in, then run the bookmarklet again — or click Debug to make a report to share privately with Josh.",
    );
  } else {
    overlay.setError(
      `This doesn't look like a MyChart page (${location.host}).\n` +
        "Open your MyChart portal, sign in, then run it there — or click Debug to make a report to share privately with Josh.",
    );
  }
})();
