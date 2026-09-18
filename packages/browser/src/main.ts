/**
 * In-browser exporter entry (console paste / bookmarklet bundle).
 *
 * Runs the SAME core phases as the CDP CLI, with transport = the page's own
 * fetch and output = an in-memory zip the user downloads. There is no salvage
 * phase in browser mode (we only see our own requests — no passive network
 * log) and no page rendering: every captured fact comes from the JSON API.
 */
import { buildReport, makeCtx, OTHER_DOCUMENTS_LIST_KEY, phases, renderGapsMd, summarizeGaps } from "@mychart/core";
import { BUILD } from "./buildInfo";
import { runCensus } from "./census";
import { BrowserClient, derivePrefix } from "./client";
import { collectDebugReport } from "./debug";
import {
  cookiesAreLive,
  embeddedMyChartOnPage,
  ladderTranscript,
  pageToken,
  preflightMyChart,
  pxMarkers,
  resolveMyChart,
  resolvedMyChart,
} from "./detect";
import { capturedRequests, installNetCapture, observedApiPaths, resourceApiEntries } from "./netcapture";
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
import { resetProgress } from "./progress";
import { ZipSink } from "./zipSink";

export interface RunOpts {
  /** Also request/download the standards C-CDA package (async server-side). */
  ccda?: boolean;
  /** Category filter from the selection card; omitted = everything (default). */
  categories?: { clinical?: boolean; messages?: boolean; documents?: boolean };
  /** Documents (dcsID) the user opted out of on the selection card. */
  excludeDocIds?: string[];
  /** Census's LoadOtherDocuments payload — pre-seeded so the documents phase
   *  works even when the structured phase is deselected. */
  docListJson?: unknown;
}

/** Phase names → what the status line calls them. */
const PHASE_LABEL: Record<string, string> = {
  structured: "clinical data",
  testResults: "test results",
  visits: "visits & notes",
  messages: "messages",
  flowsheets: "tracked readings",
  accessLog: "access log",
  documents: "documents",
  ccda: "C-CDA package",
};

async function run(opts: RunOpts = {}): Promise<Uint8Array> {
  const overlay = ensureOverlay();
  overlay.setBusy("Verifying sign-in…");
  resetProgress(); // fresh counter for this run (re-runs in the same tab)
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
    overlay.setFailed(msg);
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
    overlay.setFailed(msg);
    throw new Error(msg);
  }
  const { origin, prefix } = resolved;

  const client = new BrowserClient(origin, prefix);
  const sink = new ZipSink();
  const ctx = makeCtx({
    client,
    sink,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    log,
    // The ladder already verified this token with a real API call — seed it so
    // the run never refetches an unverified one from a different source.
    initialToken: resolved.token,
    // Hard wall-clock backstop: slow-but-not-timing-out instances must not
    // grind for hours; past this, remaining calls record as skipped.
    runBudgetMs: 15 * 60_000,
    observedApiPaths,
    excludeDocIds: opts.excludeDocIds?.length ? new Set(opts.excludeDocIds) : undefined,
  });

  log(`Exporting from ${origin}${prefix} (token via ${resolved.source}, build ${BUILD}) …`);
  markExportStarted();
  const cat = { clinical: true, messages: true, documents: true, ...(opts.categories ?? {}) };
  // Selection flow with the structured phase deselected: the documents phase
  // reads the list from the store, so seed it from the census.
  if (opts.docListJson !== undefined) {
    await ctx.store.saveJson(OTHER_DOCUMENTS_LIST_KEY, opts.docListJson);
  }
  const order: (keyof typeof phases)[] = [
    ...(cat.clinical ? (["structured", "testResults", "visits", "flowsheets", "accessLog"] as const) : []),
    ...(cat.messages ? (["messages"] as const) : []),
    ...(cat.documents ? (["documents"] as const) : []),
    ...(opts.ccda ? (["ccda"] as const) : []),
  ];
  const phaseTimings: { phase: string; ms: number; abortedDuring: boolean }[] = [];
  for (let i = 0; i < order.length; i++) {
    const name = order[i]!;
    if (ctx.signal.aborted) break; // logged out mid-run — stop, don't save shells
    overlay.setBusy(`Exporting ${PHASE_LABEL[name] ?? name} (${i + 1}/${order.length})…`);
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
  overlay.setBusy("Building the report…");
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
  } else if (!patient && cat.clinical) {
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

/**
 * Which frame are we in? The bookmarklet only ever runs top-level, but the
 * browser extension injects into EVERY frame it may touch — that's how it
 * reaches a MyChart that a wrapper portal iframes from another origin, with no
 * new tab. Exactly one frame should speak up:
 *  - "top": always (today's behavior);
 *  - "embedded": a CROSS-origin subframe that looks like MyChart before any
 *    network call (token input, PX globals, or a telltale URL) — it shows the
 *    overlay only once preflight confirms, and tells the top frame to yield;
 *  - "ignore": everything else. Same-origin subframes are the top frame's own
 *    app (document viewers etc.); ad/video frames get zero requests from us.
 */
function frameRole(): "top" | "embedded" | "ignore" {
  if (window.top === window) return "top";
  try {
    void window.top!.location.href; // throws when cross-origin
    return "ignore";
  } catch {
    /* cross-origin subframe — fall through */
  }
  const telltale = /mychart|\/inside\.asp$/i.test(location.host + location.pathname);
  return pageToken() || pxMarkers() || telltale ? "embedded" : "ignore";
}

const EMBEDDED_READY = { source: "mychart-takeout", type: "embedded-ready" } as const;
const role = frameRole();

if (role !== "ignore") {
  // Patch fetch/XHR as early as possible so we can observe how the app itself
  // authenticates its API calls (for the "app works, our fetches don't" case).
  installNetCapture();
  globalThis.__mychartExport = { run };
  // Start this run's journal (startRun stashes any prior crashed run first) — so
  // even the on-load detection probes are recorded, and a previous unfinished run
  // is available to the Debug report.
  startRun(location.host, derivePrefix(location.pathname));
}

// run() sets its own failure banner on a failed preflight; for anything else
// that throws, surface it as a failed state (not a stuck "Exporting…").
const startRunSafely = (o: RunOpts): void => {
  void run(o).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    finish("error", msg);
    if (!/signed-in MyChart page|signed out of MyChart|candidates authenticated/i.test(msg)) {
      ensureOverlay().setFailed(`Export failed: ${msg}`);
    }
  });
};

function authFailureMessage(): string {
  return pageToken()
    ? "This looks like MyChart, but none of our credential candidates authenticated — every verification bounced to login.\n" +
        "If MyChart now shows you signed out, sign in again, click any menu item, then click Debug and share the report privately with Josh."
    : `This isn't a signed-in MyChart page (${location.host}).\nOpen your MyChart portal, sign in, then run it there.`;
}

/** "scan first & choose" — verify, census (reads + cancelled headers only),
 *  then the selection card. The big default button skips all of this. */
async function scanFirst(): Promise<void> {
  const overlay = ensureOverlay();
  overlay.setBusy("Verifying sign-in…");
  const resolved = await resolveMyChart();
  if (!resolved) {
    overlay.setFailed(authFailureMessage());
    return;
  }
  overlay.setBusy("Scanning your record…");
  try {
    const census = await runCensus(resolved, (s) => overlay.setBusy(s));
    overlay.setSelect(census, (sel) =>
      startRunSafely({
        categories: {
          clinical: sel.clinical,
          messages: sel.messages,
          documents: sel.documents,
        },
        excludeDocIds: sel.excludeDocIds,
        docListJson: census.listJson,
      }),
    );
  } catch (e) {
    overlay.setFailed(`Scan failed: ${e}`);
  }
}

/** Overlay + Debug + the crashed-run notice. Interactive path: only reveal
 *  Start once we've confirmed this is a signed-in MyChart page — so the wrong
 *  page never offers a button that would just fail. */
function showOverlay(): ReturnType<typeof ensureOverlay> {
  const overlay = ensureOverlay();
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
  return overlay;
}

function showReady(overlay: ReturnType<typeof ensureOverlay>): void {
  overlay.log(`This looks like a signed-in MyChart page (${location.host}).`);
  overlay.setReady({
    onExportAll: () => startRunSafely({}),
    onScanFirst: () => void scanFirst(),
  });
}

// GET-only preflight: show the Ready state when this looks like a signed-in
// MyChart page, without sending a single POST. Verification — the part that
// can trip Epic's anti-CSRF session kill — waits for the user's explicit
// click, so merely loading the tool can never sign anyone out.
if (role === "embedded") {
  // Silent unless confirmed: a frame that isn't signed-in MyChart shows nothing
  // (the top frame's overlay already explains what's wrong).
  void (async () => {
    if ((await preflightMyChart()) !== "likely") return;
    window.top!.postMessage(EMBEDDED_READY, "*"); // carries no data — "*" is fine
    showReady(showOverlay());
  })();
} else if (role === "top") {
  const overlay = showOverlay();
  // An embedded frame took over (see frameRole): unless this page is itself
  // MyChart, its overlay would only say "not MyChart here" — yield.
  let topIsMyChart = false;
  let embeddedTookOver = false;
  window.addEventListener("message", (e) => {
    const d = e.data as { source?: unknown; type?: unknown } | null;
    if (e.source === window || d?.source !== EMBEDDED_READY.source || d?.type !== EMBEDDED_READY.type) return;
    embeddedTookOver = true;
    if (!topIsMyChart) overlay.close();
  });
  void (async () => {
    const state = await preflightMyChart();
    if (state === "likely") {
      topIsMyChart = true;
      showReady(overlay);
      return;
    }
    if (embeddedTookOver) return;
    const embedded = embeddedMyChartOnPage();
    if (embedded) {
      // A health-system portal wrapping MyChart in a cross-origin iframe: we
      // can't reach into it from here, but the user can open it top-level.
      overlay.log(`Embedded MyChart frame found → ${embedded}`);
      overlay.setFailed(
        `MyChart is embedded inside this page (${location.host}), where this tool can't reach it.\n` +
          "Open MyChart directly in a new tab (it may look broken outside its frame — the export is unaffected), then run MyChart Takeout again there.",
        { label: `Open ${new URL(embedded).host} ↗`, href: embedded },
      );
    } else if (state === "signed-out") {
      overlay.setFailed(
        `You don't appear to be signed in to MyChart (${location.host}).\n` +
          "Sign in, then run MyChart Takeout again — or click Debug to make a report to share privately with Josh.",
      );
    } else {
      overlay.setFailed(
        `This doesn't look like a MyChart page (${location.host}).\n` +
          "Open your MyChart portal, sign in, then run it there — or click Debug to make a report to share privately with Josh.",
      );
    }
  })();
}
