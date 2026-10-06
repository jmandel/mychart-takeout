import type { PhaseCtx } from "../ctx";
import { DetailLoopGuard, topKeys } from "../heal";
import { sweep } from "../paging";
import { isRecord, pad2, slug } from "../util";

interface Order {
  orderKey: string;
  /** The result group's organizationID — used only as a fallback (see below). */
  organizationID: string;
}

interface ListCursor {
  groupType: string;
  lastGroupKeys?: Record<string, string>;
}

/**
 * Orders from one GetList page. MyChart groups results (newResultGroups[]);
 * each group's resultList holds its order keys (on every instance seen, a
 * one-element list equal to the group's `key`), so prefer resultList and fall
 * back to `key`. Searches any array under a key containing "resultgroup" so a
 * renamed container still resolves. Returns null when no such array exists.
 */
function ordersFromPage(j: unknown): Order[] | null {
  const orders: Order[] = [];
  let recognized = false;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
    } else if (isRecord(o)) {
      for (const [key, val] of Object.entries(o)) {
        if (/resultgroup/i.test(key) && Array.isArray(val)) {
          recognized = true;
          for (const g of val) {
            if (!isRecord(g)) continue;
            const organizationID = typeof g.organizationID === "string" ? g.organizationID : "";
            const keys = Array.isArray(g.resultList) && g.resultList.every((k) => typeof k === "string" && k)
              ? (g.resultList as string[])
              : [g.key];
            for (const k of keys) if (typeof k === "string" && k) orders.push({ orderKey: k, organizationID });
          }
        }
        walk(val);
      }
    }
  };
  walk(j);
  return recognized ? orders : null;
}

/**
 * The full order list. GetList pages: `maxResults` is NOT honored as "all" on
 * every instance (a field report saw both completion flags false with
 * continuation data on a 9999 request, and older results silently missing).
 * Continuation, verified live: send the returned `groupBy` as `groupType` and
 * map organizationLoadMoreInfo[org].lastGroupKey into `lastGroupKeys`, merged
 * with earlier keys (a page may advance only some organizations). Complete
 * only when areResultsFullyLoaded AND isGroupingFullyLoaded are true; payloads
 * without the flags are taken as a single page (noted, as before).
 * Approach from PR #3 (hugooc).
 */
async function loadOrders(ctx: PhaseCtx): Promise<Order[] | null> {
  let firstJson: unknown;
  const res = await sweep<Order, ListCursor>({
    ctx,
    domain: "test-results",
    endpoint: "GetList",
    first: { groupType: "UNINITIALIZED" },
    fetchPage: async (cursor, page) => {
      const r = await ctx.mc.api("api/test-results/GetList", {
        groupType: cursor.groupType,
        searchString: "",
        maxResults: 9999,
        ...(cursor.lastGroupKeys ? { lastGroupKeys: cursor.lastGroupKeys } : {}),
      });
      ctx.rec("test-results", page === 0 ? "GetList" : `GetList[p${page + 1}]`, r);
      if (r.json == null) return null;
      // GetList.json stays the first response, unchanged; later pages beside it.
      await ctx.store.saveJson(`structured/test-results/${page === 0 ? "GetList" : `GetList_page_${page + 1}`}.json`, r.json);
      if (page === 0) firstJson = r.json;
      return r.json;
    },
    parse: (j, cursor) => {
      const items = ordersFromPage(j);
      if (!items || !isRecord(j)) return null;
      const a = j.areResultsFullyLoaded;
      const b = j.isGroupingFullyLoaded;
      if (typeof a !== "boolean" && typeof b !== "boolean") {
        return { items, end: true, endNote: "single page (this instance sends no completion flags)" };
      }
      if (a === true && b === true) return { items, end: true };
      const info = j.organizationLoadMoreInfo;
      const fresh: Record<string, string> = {};
      if (isRecord(info)) {
        for (const [org, v] of Object.entries(info)) {
          if (isRecord(v) && typeof v.lastGroupKey === "string" && v.lastGroupKey) fresh[org] = v.lastGroupKey;
        }
      }
      const groupType = typeof j.groupBy === "string" && j.groupBy ? j.groupBy : undefined;
      if (!Object.keys(fresh).length || !groupType) return { items, end: false };
      return { items, end: false, next: { groupType, lastGroupKeys: { ...(cursor.lastGroupKeys ?? {}), ...fresh } } };
    },
    key: (o) => JSON.stringify([o.organizationID, o.orderKey]),
  });
  if (firstJson === undefined) return null; // first request failed (already recorded)
  if (res.items.length === 0 && ordersFromPage(firstJson) === null) {
    await ctx.store.saveJson("structured/test-results/_detail_links.json", []);
    ctx.rec("test-results", "GetDetails", null,
      `no eorderids in GetList payload (top keys: ${topKeys(firstJson)})`, { outcome: "shape-mismatch" });
    return null;
  }
  return res.items;
}

/** Order-detail payload that actually carries a result. */
function usable(j: unknown): boolean {
  return isRecord(j) && (Array.isArray(j.results) && j.results.length > 0 || typeof j.orderName === "string");
}

/** phase_test_results: complete (paged) order list + per-order details. */
export async function testResults(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== test results: list + per-order details ==");
  const orders = await loadOrders(ctx);
  if (!orders) return;
  const eids = orders.map((o) => o.orderKey);
  await ctx.store.saveJson("structured/test-results/_detail_links.json", eids);
  ctx.log(`  detail links: ${eids.length}`);
  if (eids.length === 0) return;
  const guard = new DetailLoopGuard();
  let saved = 0;
  for (let i = 0; i < orders.length; i++) {
    if (ctx.signal.aborted) break;
    if (guard.abandoned()) {
      ctx.rec("test-results", "GetDetails", null,
        `abandoned after early consecutive failures; skipped remaining ${orders.length - i} orders`,
        { outcome: "skipped" });
      break;
    }
    const { orderKey: eid, organizationID: org } = orders[i]!;
    try {
      // organizationID "" is what works for the patient's own organization —
      // verified live: the group's own organizationID returned an EMPTY detail
      // for 11/12 local orders. Retry with it only if "" yields nothing (an
      // outside organization's result might need it).
      const ask = (organizationID: string) =>
        ctx.mc.api("api/test-results/GetDetails", { orderKey: eid, organizationID, PageNonce: ctx.nonce });
      let d = await ask("");
      if (!usable(d.json) && org) d = await ask(org);
      if (d.json != null && usable(d.json)) {
        const detail = d.json as Record<string, unknown>;
        const results = Array.isArray(detail.results) && detail.results.length > 0 ? detail.results : [{}];
        const first = results[0];
        const firstName = isRecord(first) && typeof first.name === "string" && first.name ? first.name : "";
        const orderName = typeof detail.orderName === "string" && detail.orderName ? detail.orderName : "";
        await ctx.store.saveJson(`structured/test-results/details/${pad2(i)}_${slug(firstName || orderName || "result", 40)}.json`, {
          eorderid: eid,
          detail,
        });
        saved++;
        guard.ok();
      } else {
        guard.fail();
        ctx.rec("test-results", `GetDetails[${i}]`, d, "no usable order details",
          d.json != null ? { outcome: "shape-mismatch" } : {});
      }
    } catch (e) {
      guard.fail();
      ctx.log(`   detail err ${e}`);
    }
  }
  ctx.rec("test-results", "GetDetails", { status: 200, body: "" }, `${saved}/${eids.length} orders`,
    saved < eids.length ? { outcome: "incomplete" } : {});
}
