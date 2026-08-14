/**
 * Single-source browser bundle config — used by both the build CLI and the
 * e2e suites so they can never drift.
 *
 * The result is memoized per process. `bun test` runs every test file in ONE
 * process, and building this entrypoint twice there makes the bundler emit
 * some modules twice ("MAX has already been declared"), which fails the second
 * build. One build per process is also simply faster.
 */
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "packages", "browser", "src", "main.ts");

let cached: Promise<string> | null = null;

export function buildBrowserBundle(): Promise<string> {
  return (cached ??= build());
}

async function build(): Promise<string> {
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
