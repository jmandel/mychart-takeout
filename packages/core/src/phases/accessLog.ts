import type { PhaseCtx } from "../ctx";
import { sweep } from "../paging";
import { isRecord } from "../util";

/**
 * Access log: who viewed the record — portal sessions (self/proxy/staff) and
 * third-party apps that pulled data via OAuth.
 *
 * Standard Epic endpoints (learned from OpenKP), paged by a `startingLine`
 * cursor with `nextLineToParse` as the next cursor; ~50 entries/page. The
 * portal's own code ends the list on `nextLineToParse === -1` (hasMoreToLoad =
 * -1 !== nextLineToParse) — that is the ONLY end signal. Observed live: the
 * third-party log keeps returning the SAME cursor while serving new rows (635
 * pages, 10k entries), and the portal log hands back -1, which as a request
 * value means "start over". See paging.ts.
 */
const KINDS: [string, string][] = [
  ["portal", "api/access-logs/GetPortalAccessLogEntries"],
  ["third-party", "api/access-logs/GetThirdPartyAccessLogEntries"],
];

export async function accessLog(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== access log: who accessed your record ==");
  for (const [kind, path] of KINDS) {
    const res = await sweep<unknown, number>({
      ctx,
      domain: "access-log",
      endpoint: `${kind}/GetEntries`,
      first: -1,
      fetchPage: async (cursor, page) => {
        const r = await ctx.mc.api(path, { startingLine: cursor });
        if (page === 0) ctx.rec("access-log", `${kind}/GetEntries`, r);
        if (!isRecord(r.json)) {
          if (page > 0) ctx.rec("access-log", `${kind}/GetEntries[p${page}]`, r);
          return null;
        }
        await ctx.store.saveJson(`structured/access-log/${kind}_page_${page}.json`, r.json);
        return r.json;
      },
      parse: (j) => {
        if (!isRecord(j) || !Array.isArray(j.entries)) return null;
        const next = typeof j.nextLineToParse === "number" ? j.nextLineToParse : undefined;
        return { items: j.entries, end: next === -1, next };
      },
      key: (e) => JSON.stringify(e),
    });
    ctx.log(`  ${kind}: ${res.items.length} unique entries over ${res.pages} page(s)${res.complete ? "" : " — INCOMPLETE"}`);
  }
}
