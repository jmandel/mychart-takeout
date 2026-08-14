/**
 * Live download counter for the overlay: total bytes received + request count,
 * fed by every transport path (BrowserClient fetchText/fetchBytes and the dom
 * phase's raw fetch). One subscriber (the overlay) renders it in place — a
 * single quiet line instead of per-request log spam.
 *
 * Byte counts are body lengths (text length ≈ bytes; exact for fetchBytes) —
 * a progress feel, not an accounting claim.
 */
let bytes = 0;
let requests = 0;
let listener: ((bytes: number, requests: number) => void) | null = null;

export function addProgress(n: number): void {
  bytes += n;
  requests++;
  listener?.(bytes, requests);
}

/** A fresh run starts its counter at zero (re-runs in the same tab). */
export function resetProgress(): void {
  bytes = 0;
  requests = 0;
  listener?.(bytes, requests);
}

/** Single subscriber (the overlay); called immediately with current totals. */
export function onProgress(fn: (bytes: number, requests: number) => void): void {
  listener = fn;
  fn(bytes, requests);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
