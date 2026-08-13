import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slug } from "@mychart/core";

/** Path segments that mark a data endpoint worth salvaging (from export.py). */
const SEGMENTS = [
  "/api/", "/Clinical/", "/Insurance/", "/Visits/",
  "/Demographics/", "/HealthAdvisories", "/CovidStatus",
];

/**
 * Salvage phase (CDP-only) — port of export.py phase_salvage. Recovers the
 * best JSON body per endpoint from the passive network log (populated while
 * the dom phase navigates). `origin` is the derived session origin, not a
 * hardcoded host.
 */
export function salvage(outDir: string, origin: string): number {
  const log = join(outDir, "raw_network", "responses.jsonl");
  if (!existsSync(log)) {
    console.log("  (no raw_network log; skipped)");
    return 0;
  }
  const cap = join(outDir, "structured", "_captured_from_navigation");
  mkdirSync(cap, { recursive: true });

  const best = new Map<string, { bf: string; sz: number }>();
  for (const ln of readFileSync(log, "utf-8").split("\n")) {
    if (!ln.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(ln);
    } catch {
      continue;
    }
    if (r.event !== "response" || r.status !== 200) continue;
    const bf = r.body_file as string | undefined;
    const u = (r.url as string) ?? "";
    if (!bf || !u.startsWith(origin) || !String(r.content_type ?? "").includes("json")) continue;
    const p = u.split("?")[0]!.slice(origin.length);
    if (!SEGMENTS.some((seg) => p.includes(seg))) continue;
    const sz = (r.body_size as number) ?? 0;
    const prev = best.get(p);
    if (!prev || sz > prev.sz) best.set(p, { bf, sz });
  }

  let n = 0;
  for (const [p, { bf }] of best) {
    const src = join(outDir, "raw_network", bf);
    if (existsSync(src)) {
      try {
        copyFileSync(src, join(cap, slug(p.replace(/^\/+|\/+$/g, ""), 80) + ".json"));
        n++;
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`  salvaged ${n} endpoint bodies`);
  return n;
}
