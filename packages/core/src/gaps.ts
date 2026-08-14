import { looksLikeLoginPage } from "./mc";
import type { ManifestEntry } from "./types";
import { isRecord } from "./util";

/**
 * Per-call outcome classification + end-of-run gaps report.
 *
 * Every endpoint the exporter hits lands in the manifest. On a familiar
 * instance almost everything is `ok`; on a new instance (different Epic
 * version, disabled features) some calls degrade. Classifying each outcome
 * and summarizing the non-ok ones turns "did it get everything?" from a
 * manual manifest read into one report — and lets a user on another instance
 * hand back a gaps report instead of their PHI.
 */
export type Outcome =
  | "ok" // 2xx with non-empty JSON
  | "empty" // 2xx but {} / [] / "" — often legitimately no data
  | "spa-shell" // 2xx HTML shell where JSON was expected
  | "redirect-login" // bounced to the login/logout surface (session lapsed)
  | "waf-challenge" // a security interstitial (WAF/bot check) answered instead of the app
  | "forbidden" // 401 / 403
  | "not-found" // 404
  | "server-error" // 5xx
  | "http-error" // other non-2xx / no status
  | "timeout" // the request hit its time budget and was aborted
  | "network-error" // the request never completed (connection/DNS/abort)
  | "shape-mismatch" // 2xx JSON, but without the fields this exporter expects
  | "skipped" // not attempted (run already aborted)
  | "skipped-circuit-open" // not attempted: too many consecutive failures
  | "skipped-deadline" // not attempted: run time budget exhausted
  | "error" // the call threw for a reason none of the above capture
  | "summary"; // a phase roll-up row, not a real HTTP call

/** Outcomes that mean "this call did not return usable data." */
const CONCERNING: ReadonlySet<Outcome> = new Set<Outcome>([
  "spa-shell",
  "redirect-login",
  "waf-challenge",
  "forbidden",
  "not-found",
  "server-error",
  "http-error",
  "timeout",
  "network-error",
  "shape-mismatch",
  "error",
]);

/** Outcomes for calls that were never made (run aborted first). */
const SKIPPED: ReadonlySet<Outcome> = new Set<Outcome>([
  "skipped",
  "skipped-circuit-open",
  "skipped-deadline",
]);

/**
 * Map a thrown per-call error (from Mc's guard/timeout/retry machinery) to an
 * outcome, so phases can record WHY an endpoint yielded nothing.
 */
export function classifyError(err: unknown): Outcome {
  const m = String(err);
  if (/skipped \(run-deadline/.test(m)) return "skipped-deadline";
  if (/skipped \(circuit-open/.test(m)) return "skipped-circuit-open";
  if (/skipped \(/.test(m)) return "skipped";
  if (/timeout/i.test(m)) return "timeout";
  if (/network-error/i.test(m)) return "network-error";
  return "error";
}

/**
 * A WAF / bot-mitigation interstitial: HTML that is neither the app shell nor
 * a login page. Matches the F5/Imperva/Cloudflare families' block pages.
 */
function looksLikeWafChallenge(body: string): boolean {
  const head = body.slice(0, 4000);
  return /requested url was rejected|support id\s*[:#]|incident id|verify you are a human|are you a robot|captcha|cf-browser-verification|_Incapsula_|bot.?detection|pardon our interruption/i.test(
    head,
  );
}

function jsonIsEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isRecord(v)) return Object.keys(v).length === 0;
  return false;
}

/** What kind of thing came back. Pass the fullest response you have. */
export function classifyOutcome(res: {
  status: number | null;
  body?: string;
  url?: string;
  contentType?: string | null;
  json?: unknown;
}): Outcome {
  const url = res.url ?? "";
  if (/\/Authentication\/Login|action=logout|\/bye\.asp/i.test(url)) return "redirect-login";
  const s = res.status;
  if (s === null || s === undefined) return "http-error";
  // A challenge page can come back with 200, 403, or 5xx — sniff it before the
  // status buckets so a WAF block isn't misread as forbidden/server-error.
  const body = res.body ?? "";
  const ct = (res.contentType ?? "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*(<!doctype html|<html)/i.test(body.slice(0, 200));
  // Some instances REWRITE to the login page (200, unchanged URL) instead of
  // redirecting — catch that by content, same bucket as the redirect.
  if (isHtml && looksLikeLoginPage(body)) return "redirect-login";
  if (isHtml && looksLikeWafChallenge(body)) return "waf-challenge";
  if (s === 401 || s === 403) return "forbidden";
  if (s === 404) return "not-found";
  if (s >= 500) return "server-error";
  if (s < 200 || s >= 300) return "http-error";
  // 2xx
  if (res.json !== undefined && res.json !== null) return jsonIsEmpty(res.json) ? "empty" : "ok";
  if (isHtml) return "spa-shell";
  return body ? "ok" : "empty";
}

export interface GapsSummary {
  attempted: number; // real HTTP calls (excludes summary + skipped rows)
  ok: number;
  empty: number;
  byOutcome: Record<string, number>;
  concerns: { domain: string; endpoint: string; status: number | null; outcome: Outcome; note: string }[];
  emptyEndpoints: { domain: string; endpoint: string }[];
  /** Endpoints never attempted because the run aborted first. */
  skipped: { domain: string; endpoint: string; note: string }[];
  /** Set when the run stopped early (logout / circuit breaker / deadline). */
  stoppedEarly?: string;
}

export function summarizeGaps(manifest: ManifestEntry[], stoppedEarly?: string): GapsSummary {
  const byOutcome: Record<string, number> = {};
  const concerns: GapsSummary["concerns"] = [];
  const emptyEndpoints: GapsSummary["emptyEndpoints"] = [];
  const skipped: GapsSummary["skipped"] = [];
  let attempted = 0;
  let ok = 0;
  let empty = 0;
  for (const e of manifest) {
    const outcome = (e.outcome as Outcome | undefined) ?? "summary";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    if (outcome === "summary") continue;
    if (SKIPPED.has(outcome)) {
      skipped.push({ domain: e.domain, endpoint: e.endpoint, note: e.note });
      continue;
    }
    attempted++;
    if (outcome === "ok") ok++;
    else if (outcome === "empty") {
      empty++;
      emptyEndpoints.push({ domain: e.domain, endpoint: e.endpoint });
    } else if (CONCERNING.has(outcome)) {
      concerns.push({
        domain: e.domain,
        endpoint: e.endpoint,
        status: e.status,
        outcome,
        note: e.note,
      });
    }
  }
  return { attempted, ok, empty, byOutcome, concerns, emptyEndpoints, skipped, ...(stoppedEarly ? { stoppedEarly } : {}) };
}

/** Human-readable GAPS.md. */
export function renderGapsMd(g: GapsSummary): string {
  const L: string[] = [];
  L.push("# Export gaps report", "");
  L.push(
    `Of **${g.attempted}** endpoint calls: **${g.ok} ok**, **${g.empty} empty** ` +
      `(likely no data), **${g.concerns.length} need attention**.`,
    "",
  );
  if (g.stoppedEarly) {
    L.push(
      `**Run stopped early:** ${g.stoppedEarly} — endpoints after that point were not attempted, ` +
        `so this export is incomplete.`,
      "",
    );
  }
  if (g.concerns.length === 0) {
    L.push("No failed or degraded endpoints. ✅", "");
  } else {
    L.push("## Needs attention", "");
    L.push("| Domain | Endpoint | Status | Outcome | Note |");
    L.push("|---|---|---|---|---|");
    for (const c of g.concerns) {
      L.push(`| ${c.domain} | ${c.endpoint} | ${c.status ?? ""} | ${c.outcome} | ${c.note} |`);
    }
    L.push("");
    L.push(
      "*`spa-shell` = the app HTML came back instead of JSON (endpoint may have moved); " +
        "`redirect-login` = the session lapsed mid-run; `waf-challenge` = a security " +
        "interstitial answered instead of the app; `timeout`/`network-error` = the request " +
        "never completed; `shape-mismatch` = the endpoint answered but without the expected " +
        "fields; `server-error`/`forbidden`/`not-found` = the instance may not offer this " +
        "endpoint or expects different parameters. A `substituted-path` note means the call " +
        "succeeded only at an alternate path observed from the app's own traffic.*",
      "",
    );
  }
  if (g.skipped.length) {
    L.push(`## Skipped (${g.skipped.length} — run aborted before these were attempted)`, "");
    for (const s of g.skipped) L.push(`- ${s.domain}/${s.endpoint}${s.note ? ` — ${s.note}` : ""}`);
    L.push("");
  }
  if (g.emptyEndpoints.length) {
    L.push("## Empty (no data returned — usually legitimate)", "");
    for (const e of g.emptyEndpoints) L.push(`- ${e.domain}/${e.endpoint}`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
