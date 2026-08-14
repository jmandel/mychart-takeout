/**
 * Self-healing helpers for unseen instances: retry a moved endpoint at the
 * path the app itself uses, stop grinding through a systematically-broken
 * detail loop, and describe unexpected payload shapes without leaking values.
 */
import { isRecord } from "./util";

/**
 * When a catalog endpoint answers not-found/spa-shell, the app may simply
 * serve its API at a different base (renamed prefix, versioned area). The
 * driver's traffic log knows the paths the app ACTUALLY calls; match the
 * catalog path's last two segments (area/Method) against them and return an
 * absolute alternative to retry once. Returns null when nothing matches.
 */
export function findObservedAlternative(
  catalogPath: string,
  prefix: string,
  observed: string[],
): string | null {
  const segs = catalogPath.split("?")[0]!.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const tail = segs.slice(-2).join("/").toLowerCase();
  const current = `${prefix}/${catalogPath.split("?")[0]}`.toLowerCase();
  for (const p of observed) {
    const clean = p.split("?")[0]!;
    const ps = clean.split("/").filter(Boolean);
    if (ps.length < 2) continue;
    if (ps.slice(-2).join("/").toLowerCase() !== tail) continue;
    if (clean.toLowerCase() === current) continue;
    return clean.startsWith("/") ? clean : `/${clean}`;
  }
  return null;
}

/**
 * Early-abandon guard for per-item detail loops (orders, threads, visits):
 * when the FIRST few items all fail and nothing has succeeded, the collection
 * is systematically broken — hundreds more attempts would each burn a full
 * timeout to learn nothing. One success ever disables the guard (a mixed
 * collection is worth finishing).
 */
export class DetailLoopGuard {
  private failures = 0;
  private successes = 0;
  constructor(private readonly strikes = 3) {}
  ok(): void {
    this.successes++;
  }
  fail(): void {
    this.failures++;
  }
  abandoned(): boolean {
    return this.successes === 0 && this.failures >= this.strikes;
  }
}

/** Top-level key NAMES of a payload (never values) — for shape-mismatch notes. */
export function topKeys(v: unknown, max = 12): string {
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v);
    return keys.slice(0, max).join(",") + (keys.length > max ? ",…" : "");
  }
  return typeof v;
}
