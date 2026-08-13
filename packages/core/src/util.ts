/** Helpers ported 1:1 from export.py — keep semantics identical. */

/** export.py slug(): non-alphanumerics → _, strip _, truncate, default "item". */
export function slug(s: string | null | undefined, n = 40): string {
  const t = (s ?? "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, n);
  return t || "item";
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * export.py collect(): all non-empty STRING values found at `key`, walking
 * dicts/lists depth-first. Note the Python quirk: when a dict key matches but
 * the value is not a non-empty string, the value is NOT descended into.
 */
export function collectStrings(obj: unknown, key: string, acc: string[] = []): string[] {
  if (isRecord(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key && typeof v === "string" && v) acc.push(v);
      else collectStrings(v, key, acc);
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectStrings(v, key, acc);
  }
  return acc;
}

/** True if any nested key (case-insensitive) has a truthy value. */
export function anyTrueDeep(obj: unknown, keyLower: string): boolean {
  if (isRecord(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === keyLower) {
        if (v) return true;
      } else if (anyTrueDeep(v, keyLower)) return true;
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) if (anyTrueDeep(v, keyLower)) return true;
  }
  return false;
}

/** Python f"{i:02d}" / f"{i:03d}". */
export function pad2(i: number): string {
  return String(i).padStart(2, "0");
}
export function pad3(i: number): string {
  return String(i).padStart(3, "0");
}

/** Random 32-hex nonce (Python uuid4().hex equivalent); works in Bun + browser. */
export function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
