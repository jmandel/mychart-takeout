/**
 * Single-source browser bundle config — used by both the build CLI and the
 * integration test so they can never drift.
 */
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "packages", "browser", "src", "main.ts");

export async function buildBrowserBundle(): Promise<string> {
  const attempt = async (format: "iife" | "esm") =>
    Bun.build({
      entrypoints: [ENTRY],
      target: "browser",
      format,
      minify: true,
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
