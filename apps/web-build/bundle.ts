/**
 * Single-source browser bundle config — used by both the build CLI and the
 * integration test so they can never drift.
 */
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "packages", "browser", "src", "main.ts");

/**
 * "abc1234 2026-08-14T15:04Z" — git SHA + build time, injected as the
 * __MCT_BUILD__ constant (see packages/browser/src/buildInfo.ts for why a
 * frozen-at-install bookmarklet must carry its own vintage).
 */
export function buildStamp(): string {
  let sha = "nogit";
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir });
    const out = new TextDecoder().decode(p.stdout).trim();
    if (p.exitCode === 0 && out) sha = out;
  } catch {
    /* not a git checkout (e.g. tarball build) */
  }
  return `${sha} ${new Date().toISOString().slice(0, 16)}Z`;
}

export async function buildBrowserBundle(): Promise<string> {
  const define = { __MCT_BUILD__: JSON.stringify(buildStamp()) };
  const attempt = async (format: "iife" | "esm") =>
    Bun.build({
      entrypoints: [ENTRY],
      target: "browser",
      format,
      minify: true,
      define,
    });

  let result = await attempt("iife").catch(() => null);
  if (!result || !result.success) {
    // Older Bun versions without iife support: wrap minified esm ourselves.
    const esm = await attempt("esm");
    if (!esm.success) {
      throw new Error(
        "browser bundle failed:\n" + esm.logs.map((l) => String(l)).join("\n"),
      );
    }
    const code = await esm.outputs[0]!.text();
    if (/^\s*export\b/m.test(code)) {
      throw new Error("esm fallback produced export statements; cannot IIFE-wrap");
    }
    return `(()=>{${code}\n})();`;
  }
  return await result.outputs[0]!.text();
}
