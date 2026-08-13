import { classifyOutcome } from "./gaps";
import { Mc } from "./mc";
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
}

export function makeCtx(opts: MakeCtxOpts): PhaseCtx {
  const log = opts.log ?? ((m: string) => console.log(m));
  const manifest: ManifestEntry[] = [];
  return {
    client: opts.client,
    mc: new Mc(opts.client),
    store: new ExportStore(opts.sink),
    nonce: opts.nonce ?? randomNonce(),
    timeZone: opts.timeZone ?? "UTC",
    manifest,
    rec(domain, endpoint, res, note = "", extra = {}) {
      const ok = res !== null && res.status === 200;
      // Classify real HTTP responses (they carry url/contentType); a bare
      // {status,body} roll-up row stays unclassified (a "summary" row).
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
