import type { PhaseCtx } from "../ctx";
import { classifyError, classifyOutcome } from "../gaps";
import { DetailLoopGuard, topKeys } from "../heal";
import { isRecord, pad2, slug } from "../util";

const MAX_LIST_PAGES = 100;
type Order = { orderKey: string; organizationID: string };

/**
 * A group can contain several orders (e.g. encounter grouping). Prefer its
 * resultList; older payloads expose only the group's key. Preserve the source
 * organization, and dedupe by BOTH source and order across all pages.
 */
function ordersFromList(getList: unknown): { orders: Order[]; recognized: boolean; malformed: boolean } {
  const orders: Order[] = [];
  let recognized = false;
  let malformed = false;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
    } else if (isRecord(o)) {
      for (const [key, val] of Object.entries(o)) {
        if (/resultgroup/i.test(key) && Array.isArray(val)) {
          recognized = true;
          for (const g of val) {
            if (!isRecord(g)) {
              malformed = true;
              continue;
            }
            if (g.resultList !== undefined && !Array.isArray(g.resultList)) malformed = true;
            if (g.organizationID != null && typeof g.organizationID !== "string") malformed = true;
            const organizationID = typeof g.organizationID === "string" ? g.organizationID : "";
            for (const orderKey of Array.isArray(g.resultList) ? g.resultList : [g.key]) {
              if (typeof orderKey === "string" && orderKey) orders.push({ orderKey, organizationID });
              else malformed = true;
            }
          }
        }
        walk(val);
      }
    }
  };
  walk(getList);
  return { orders, recognized, malformed };
}

/** Keep each server response intact: GetList.json is the first page, as before. */
async function loadList(ctx: PhaseCtx): Promise<{ orders: Order[]; completeness: string }> {
  const orders: Order[] = [];
  const seenOrders = new Set<string>();
  const seenCursors = new Set<string>();
  let body: Record<string, unknown> = {
    groupType: "UNINITIALIZED",
    searchString: "",
    maxResults: 9999,
  };
  let pages = 0;
  let completeness = "incomplete";
  let reason = "list page limit reached";
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    if (ctx.signal.aborted) {
      reason = "run stopped before list discovery finished";
      break;
    }
    const endpoint = page === 1 ? "GetList" : `GetList[p${page}]`;
    let r;
    try {
      r = await ctx.mc.api("api/test-results/GetList", body);
    } catch (e) {
      ctx.rec("test-results", endpoint, null, "list request failed", { outcome: classifyError(e) });
      reason = "list request failed before completion";
      break;
    }
    ctx.rec("test-results", endpoint, r);
    const j = r.json;
    if (j != null) {
      await ctx.store.saveJson(`structured/test-results/${page === 1 ? "GetList" : `GetList_page_${page}`}.json`, j);
    }
    if (classifyOutcome(r) !== "ok" || !isRecord(j)) {
      reason = "list request did not return usable JSON";
      break;
    }
    pages++;
    const found = ordersFromList(j);
    for (const order of found.orders) {
      const id = JSON.stringify([order.organizationID, order.orderKey]);
      if (!seenOrders.has(id)) {
        seenOrders.add(id);
        orders.push(order);
      }
    }
    if (!found.recognized) {
      ctx.rec("test-results", "GetDetails", null,
        `no eorderids in GetList payload (top keys: ${topKeys(j)})`, { outcome: "shape-mismatch" });
      reason = "list payload has no recognized result groups";
      break;
    }
    if (found.malformed) {
      reason = "list contains unrecognized order or organization keys";
      ctx.rec("test-results", "GetList[shape]", null, reason, { outcome: "shape-mismatch" });
      break;
    }
    if (body.groupType !== "UNINITIALIZED" && j.groupBy !== body.groupType) {
      reason = "list grouping changed or disappeared during pagination";
      break;
    }
    if (j.areResultsFullyLoaded === true && j.isGroupingFullyLoaded === true) {
      completeness = "complete";
      reason = "both list completion flags are true";
      break;
    }
    if (j.areResultsFullyLoaded !== false && j.isGroupingFullyLoaded !== false) {
      completeness = "unverified";
      reason = "list completion flags are missing or unrecognized";
      break;
    }
    // GetList expects lastGroupKeys (organization -> group key), not the
    // response's organizationLoadMoreInfo objects or their uniqueGroupCount.
    const info = j.organizationLoadMoreInfo;
    if (!isRecord(info) || Object.keys(info).length === 0 ||
      Object.values(info).some((v) => !isRecord(v) || typeof v.lastGroupKey !== "string")) {
      reason = "more results reported but continuation metadata is missing or invalid";
      break;
    }
    // A page may update only some organizations. Retain the others' positions
    // so their next request cannot restart at the beginning.
    const previousKeys = isRecord(body.lastGroupKeys) ? body.lastGroupKeys : {};
    const lastGroupKeys = Object.fromEntries(Object.entries({
      ...previousKeys,
      ...Object.fromEntries(Object.entries(info)
        .map(([org, value]) => [org, (value as Record<string, unknown>).lastGroupKey as string])),
    }).sort(([a], [b]) => a.localeCompare(b)));
    if (!Object.values(lastGroupKeys).some(Boolean) || typeof j.groupBy !== "string" ||
      !j.groupBy || j.groupBy === "UNINITIALIZED") {
      reason = "more results reported but no usable cursor or grouping mode";
      break;
    }
    const cursor = JSON.stringify([j.groupBy, lastGroupKeys]);
    if (seenCursors.has(cursor)) {
      reason = "more results reported but continuation cursor repeated";
      break;
    }
    seenCursors.add(cursor);
    body = { ...body, groupType: j.groupBy, lastGroupKeys };
  }
  await ctx.store.saveJson("structured/test-results/_pagination.json", {
    completeness, pages, discoveredOrders: orders.length, reason,
  });
  ctx.rec("test-results", "GetList[completeness]", null,
    `list ${completeness}: ${reason}; ${orders.length} discovered orders in ${pages} pages`,
    { outcome: completeness === "complete" ? "summary" : "incomplete" });
  return { orders, completeness };
}

/** phase_test_results: paginated list + per-order details keyed by source and eorderid. */
export async function testResults(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== test results: list + per-order details ==");
  const { orders, completeness } = await loadList(ctx);
  const eids = orders.map((o) => o.orderKey);
  await ctx.store.saveJson("structured/test-results/_detail_links.json", eids);
  ctx.log(`  detail links: ${eids.length}`);
  const guard = new DetailLoopGuard();
  let saved = 0;
  for (let i = 0; i < eids.length; i++) {
    if (ctx.signal.aborted) break;
    if (guard.abandoned()) {
      ctx.rec(
        "test-results",
        "GetDetails",
        null,
        `abandoned after early consecutive failures; skipped remaining ${eids.length - i} orders`,
        { outcome: "skipped" },
      );
      break;
    }
    const eid = eids[i]!;
    const organizationID = orders[i]!.organizationID;
    try {
      const d = await ctx.mc.api("api/test-results/GetDetails", {
        orderKey: eid,
        organizationID,
        PageNonce: ctx.nonce,
      });
      if (classifyOutcome(d) === "ok" && isRecord(d.json) &&
        (Array.isArray(d.json.results) || typeof d.json.orderName === "string")) {
        const detail = d.json;
        // deterministic name: NN_<orderName>
        let name = "item";
        const results =
          isRecord(detail) && Array.isArray(detail.results) && detail.results.length > 0
            ? detail.results
            : [{}];
        const first = results[0];
        const firstName = isRecord(first) && typeof first.name === "string" && first.name ? first.name : "";
        const orderName =
          isRecord(detail) && typeof detail.orderName === "string" && detail.orderName
            ? detail.orderName
            : "";
        name = slug(firstName || orderName || "result", 40);
        await ctx.store.saveJson(`structured/test-results/details/${pad2(i)}_${name}.json`, {
          eorderid: eid,
          ...(organizationID ? { organizationID } : {}),
          detail,
        });
        saved++;
        guard.ok();
      } else {
        guard.fail();
        ctx.rec("test-results", `GetDetails[${i}]`, d, "no usable order details", {
          outcome: classifyOutcome(d) === "ok" ? "shape-mismatch" : classifyOutcome(d),
        });
      }
    } catch (e) {
      guard.fail();
      ctx.rec("test-results", `GetDetails[${i}]`, null, "detail request failed", { outcome: classifyError(e) });
    }
  }
  ctx.rec("test-results", "GetDetails", null,
    `${saved}/${eids.length} discovered orders saved; list ${completeness}`,
    { outcome: saved === eids.length ? "summary" : "incomplete" });
}
