import { isRecord } from "../util";

/**
 * Python truthiness for parsed JSON values: None/null, "", 0, false, empty
 * arrays and empty objects are falsy (export.py relies on `if not j` checks).
 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === 0 || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}
