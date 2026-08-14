import { classifyOutcome } from "./gaps";
import { makeRunHealth, Mc, type RunHealth } from "./mc";
import { ExportStore } from "./store";
import { randomNonce } from "./util";
import type { DomAccess, ManifestEntry, McResponse, MyChartClient, Sink } from "./types";

/** What rec() accepts: a real response (classified) or a synthetic summary row. */
type RecResponse =
  | (Pick<McResponse, "status" | "body"> & Partial<Pick<McResponse, "url" | "contentType" | "json">>)
  | null;

/** Everything a phase needs; drivers build one of these and hand it over. */
export interface PhaseCtx {
  client: MyChartClient;
  mc: Mc;
  store: ExportStore;
  nonce: string;
  /** IANA tz used in request bodies; drivers pass the machine tz via Intl. */
  timeZone: string;
  manifest: ManifestEntry[];
  /** Mirror of export.py Exporter.rec: manifest row + one status line. */
  rec(
    domain: string,
    endpoint: string,
    res: RecResponse,
    note?: string,
    extra?: Record<string, unknown>,
  ): void;
  log(msg: string): void;
  wait(ms: number): Promise<void>;
  /**
   * Set true when the session dies mid-run (a call redirected to login), the
   * circuit breaker opens, or the run deadline passes. Mc sets it; phases and
   * the driver's phase loop check it and stop instead of saving shells.
   */
  signal: { aborted: boolean; reason: string };
  /** Shared failure/deadline state consumed by Mc's circuit breaker. */
  health: RunHealth;
  /**
   * Same-origin API paths the app itself was seen calling (driver-provided,
   * e.g. from a traffic log). Phases use it to retry a moved endpoint at the
   * path the app actually uses.
   */
  observedApiPaths?: () => string[];
  /** Absent when the environment can't render pages; phases degrade + note it. */
  dom?: DomAccess;
  /** dom phase: also capture PNGs (CDP only). */
  screenshots?: boolean;
}

export interface MakeCtxOpts {
  client: MyChartClient;
  sink: Sink;
  nonce?: string;
  timeZone?: string;
  dom?: DomAccess;
  screenshots?: boolean;
  log?: (msg: string) => void;
  /** Detection-verified token to seed Mc with (skip an unverified refetch). */
  initialToken?: string | null;
  /** Wall-clock budget for the whole run; past it, remaining calls skip. */
  runBudgetMs?: number;
  observedApiPaths?: () => string[];
}

export function makeCtx(opts: MakeCtxOpts): PhaseCtx {
  const log = opts.log ?? ((m: string) => console.log(m));
  const manifest: ManifestEntry[] = [];
  const signal = { aborted: false, reason: "" };
  const health = makeRunHealth(opts.runBudgetMs ?? 0);
  return {
    client: opts.client,
    mc: new Mc(opts.client, signal, { initialToken: opts.initialToken, health }),
    store: new ExportStore(opts.sink),
    nonce: opts.nonce ?? randomNonce(),
    timeZone: opts.timeZone ?? "UTC",
    manifest,
    signal,
    health,
    observedApiPaths: opts.observedApiPaths,
    rec(domain, endpoint, res, note = "", extra = {}) {
      const ok = res !== null && res.status === 200;
      // Classify real HTTP responses (they carry url/contentType); a bare
      // {status,body} roll-up row stays unclassified (a "summary" row).
      // `extra` is spread last on purpose: extra.outcome overrides, so phases
      // can record timeout/shape-mismatch/skipped rows for calls that threw.
      let outcome: string | undefined;
      if (res === null) outcome = "empty";
      else if ("url" in res || "contentType" in res) outcome = classifyOutcome(res);
      manifest.push({
        domain,
        endpoint,
        status: res?.status ?? null,
        bytes: res?.body.length ?? 0,
        note,
        ...(outcome ? { outcome } : {}),
        ...extra,
      });
      log(`  ${ok ? "OK " : "!! "}${domain}/${endpoint} [${res?.status}] ${note}`);
    },
    log,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    dom: opts.dom,
    screenshots: opts.screenshots,
  };
}
