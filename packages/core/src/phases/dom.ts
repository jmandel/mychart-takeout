import { SECTIONS } from "../catalog";
import type { PhaseCtx } from "../ctx";

/** phase_dom: per-section rendered HTML/text snapshots (+ optional PNGs). */
export async function dom(ctx: PhaseCtx): Promise<void> {
  if (!ctx.dom) return;
  const access = ctx.dom;
  ctx.log("\n== dom snapshots" + (ctx.screenshots ? " + screenshots" : "") + " ==");
  for (const [name, path] of SECTIONS) {
    try {
      await access.withSection(path, 3000, async (page) => {
        await ctx.store.saveText(`dom/${name}.html`, await page.html());
        await ctx.store.saveText(`dom/${name}.txt`, await page.text());
        if (ctx.screenshots && page.screenshot) {
          await page.screenshot(`screenshots/${name}.png`);
        }
      });
      ctx.log(`  ${name}`);
    } catch (e) {
      ctx.log(`  ERR ${name} ${e}`);
    }
  }
}
