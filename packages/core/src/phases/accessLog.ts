import type { PhaseCtx } from "../ctx";
import { isRecord } from "../util";

/**
 * phase_access_log: the record's access history — who opened your chart and
 * when (portal/self) and which third-party apps pulled your data (OAuth).
 * Standard Epic endpoints (learned from OpenKP), paginated by a `startingLine`
 * cursor with `nextLineToParse` as the next cursor; 50 entries/page.
 * Read-only and often the most patient-empowering data in the record.
 */
const KINDS: [kind: string, path: string][] = [
  ["portal", "api/access-logs/GetPortalAccessLogEntries"],
  ["third-party", "api/access-logs/GetThirdPartyAccessLogEntries"],
];

export async function accessLog(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== access log: who accessed your record ==");
  for (const [kind, path] of KINDS) {
    let cursor = -1;
    let page = 0;
    let total = 0;
    const seenCursors = new Set<number>();
    while (page < 120) {
      const r = await ctx.mc.api(path, { startingLine: cursor });
      if (page === 0) ctx.rec("access-log", `${kind}/GetEntries`, r);
      const j = r.json;
      if (!isRecord(j)) break;
      await ctx.store.saveJson(`structured/access-log/${kind}_page_${page}.json`, j);
      const entries = Array.isArray(j.entries) ? j.entries : [];
      total += entries.length;
      const next = typeof j.nextLineToParse === "number" ? j.nextLineToParse : null;
      page++;
      if (entries.length === 0 || next === null || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    ctx.log(`  ${kind}: ${total} entries over ${page} page(s)`);
  }
}
