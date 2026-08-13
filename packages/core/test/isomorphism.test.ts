import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Isomorphism guard: packages/core/src must stay environment-free so the same
 * code runs in Bun and inside a browser page. (The test itself runs in Bun,
 * so IT may use fs — the code under src/ may not.)
 */
const FORBIDDEN: [pattern: RegExp, why: string][] = [
  [/from\s+["']node:/, "node builtin import"],
  [/from\s+["']fs["']/, "fs import"],
  [/require\s*\(/, "require()"],
  [/playwright/i, "playwright reference"],
  [/\bBun\./, "Bun global"],
  [/\bprocess\./, "process global"],
  [/\bdocument\./, "document global (belongs in packages/browser)"],
  [/\bwindow\./, "window global (belongs in packages/browser)"],
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("core is isomorphic", () => {
  const src = join(import.meta.dir, "..", "src");
  for (const file of tsFiles(src)) {
    test(file.slice(src.length + 1), () => {
      const text = readFileSync(file, "utf-8");
      for (const [pattern, why] of FORBIDDEN) {
        expect(pattern.test(text), `${why} (${pattern})`).toBe(false);
      }
    });
  }
});
