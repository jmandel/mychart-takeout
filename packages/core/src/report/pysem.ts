/**
 * Python-semantics helpers for the report port. build_reportlib.py leans on
 * dict.get defaults, truthiness, and str() rendering; these mirror those
 * exactly so the TS output stays byte-identical to the reference.
 */
import { isRecord } from "../util";

/** Python truthiness: None/False/0/""/empty list/empty dict are falsy. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python str() as seen in f-strings: None → "None", booleans capitalized. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** dict.get(k, dflt): the default applies only when the key is ABSENT. */
export function getD(o: unknown, k: string, dflt: unknown = null): unknown {
  if (isRecord(o) && k in o) return o[k];
  return dflt;
}

/** Python `a or b`: keep `a` only when truthy. */
export function orElse(a: unknown, b: unknown): unknown {
  return truthy(a) ? a : b;
}

/** o.get(k, "") rendered for interpolation (missing → "", None → "None"). */
export function pyGet(o: unknown, k: string): string {
  if (isRecord(o) && k in o) return pyStr(o[k]);
  return "";
}

export const asRec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
