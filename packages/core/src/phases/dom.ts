import { SECTIONS } from "../catalog";
import type { PhaseCtx } from "../ctx";

/**
 * phase_dom: per-section rendered HTML/text snapshots (+ optional PNGs) —
 * but only for pages that actually contain something.
 *
 * When the driver can't execute scripts (fetch-based section access), every
 * SPA route returns the same inert shell; a real export was 38 files of which
 * 8+ were byte-equivalent boilerplate with misleading names. So the phase
 * first captures a BASELINE from a deliberately nonexistent app route (the
 * router serves its shell for any app/* path) and skips any section whose
 * text is ~identical to it. Drivers that fully render (CDP) produce pages
 * that differ from the baseline, so everything still saves there; instances
 * that 404 the probe degrade to saving everything. Skips are recorded.
 */
const SHELL_PROBE_PATH = "app/__mct_shell_probe__";
/** A page sharing at least this fraction of its lines with the shell is the shell. */
const SHELL_OVERLAP = 0.98;

function lineSet(text: string): Set<string> {
  const s = new Set<string>();
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (t.length > 2) s.add(t);
  }
  return s;
}

/** Fraction of `page`'s lines that also appear in `baseline`. Empty page = 1. */
export function shellOverlap(pageText: string, baselineText: string): number {
  const page = lineSet(pageText);
  if (page.size === 0) return 1;
  const base = lineSet(baselineText);
  let hit = 0;
  for (const l of page) if (base.has(l)) hit++;
  return hit / page.size;
}

export async function dom(ctx: PhaseCtx): Promise<void> {
  if (!ctx.dom) return;
  const access = ctx.dom;
  ctx.log("\n== dom snapshots" + (ctx.screenshots ? " + screenshots" : "") + " ==");
  let baseline = "";
  try {
    baseline = await access.withSection(SHELL_PROBE_PATH, 1500, (page) => page.text());
  } catch {
    /* no baseline (e.g. probe bounced) — save everything, as before */
  }
  let saved = 0;
  let skipped = 0;
  for (const [name, path] of SECTIONS) {
    if (ctx.signal.aborted) break;
    try {
      await access.withSection(path, 3000, async (page) => {
        const text = await page.text();
        if (shellOverlap(text, baseline) >= SHELL_OVERLAP) {
          skipped++;
          ctx.log(`  ${name} (app-shell boilerplate — not saved)`);
          return;
        }
        await ctx.store.saveText(`dom/${name}.html`, await page.html());
        await ctx.store.saveText(`dom/${name}.txt`, text);
        saved++;
        if (ctx.screenshots && page.screenshot) {
          await page.screenshot(`screenshots/${name}.png`);
        }
        ctx.log(`  ${name}`);
      });
    } catch (e) {
      ctx.log(`  ERR ${name} ${e}`);
    }
  }
  ctx.rec(
    "dom",
    "snapshots",
    { status: 200, body: "" },
    `${saved} pages saved${skipped ? `, ${skipped} skipped (app-shell boilerplate)` : ""}`,
  );
}
