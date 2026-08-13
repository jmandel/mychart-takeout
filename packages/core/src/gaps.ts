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
  | "forbidden" // 401 / 403
  | "not-found" // 404
  | "server-error" // 5xx
  | "http-error" // other non-2xx / no status
  | "summary"; // a phase roll-up row, not a real HTTP call

/** Outcomes that mean "this call did not return usable data." */
const CONCERNING: ReadonlySet<Outcome> = new Set<Outcome>([
  "spa-shell",
  "redirect-login",
  "forbidden",
  "not-found",
  "server-error",
  "http-error",
]);

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
  if (s === 401 || s === 403) return "forbidden";
  if (s === 404) return "not-found";
  if (s >= 500) return "server-error";
  if (s < 200 || s >= 300) return "http-error";
  // 2xx
  if (res.json !== undefined && res.json !== null) return jsonIsEmpty(res.json) ? "empty" : "ok";
  const body = res.body ?? "";
  const ct = (res.contentType ?? "").toLowerCase();
  if (ct.includes("html") || /^\s*(<!doctype html|<html)/i.test(body.slice(0, 200))) {
    return "spa-shell";
  }
  return body ? "ok" : "empty";
}

export interface GapsSummary {
  attempted: number; // real HTTP calls (excludes summary rows)
  ok: number;
  empty: number;
  byOutcome: Record<string, number>;
  concerns: { domain: string; endpoint: string; status: number | null; outcome: Outcome; note: string }[];
  emptyEndpoints: { domain: string; endpoint: string }[];
}

export function summarizeGaps(manifest: ManifestEntry[]): GapsSummary {
  const byOutcome: Record<string, number> = {};
  const concerns: GapsSummary["concerns"] = [];
  const emptyEndpoints: GapsSummary["emptyEndpoints"] = [];
  let attempted = 0;
  let ok = 0;
  let empty = 0;
  for (const e of manifest) {
    const outcome = (e.outcome as Outcome | undefined) ?? "summary";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    if (outcome === "summary") continue;
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
  return { attempted, ok, empty, byOutcome, concerns, emptyEndpoints };
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
        "`redirect-login` = the session lapsed mid-run; `server-error`/`forbidden`/`not-found` " +
        "= the instance may not offer this endpoint or expects different parameters.*",
      "",
    );
  }
  if (g.emptyEndpoints.length) {
    L.push("## Empty (no data returned — usually legitimate)", "");
    for (const e of g.emptyEndpoints) L.push(`- ${e.domain}/${e.endpoint}`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
