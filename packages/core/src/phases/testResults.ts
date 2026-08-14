import type { PhaseCtx } from "../ctx";
import { DetailLoopGuard, topKeys } from "../heal";
import { isRecord, pad2, slug } from "../util";

/**
 * Collect per-order keys (eorderid) from the GetList payload. On MyChart these
 * are `newResultGroups[].key`; we search for any array under a key containing
 * "resultgroup" whose objects carry a string `key`, so payload-shape drift or
 * a renamed container still resolves. Order-preserving dedupe.
 */
function eorderidsFromList(getList: unknown): string[] {
  const eids: string[] = [];
  const push = (k: unknown) => {
    if (typeof k === "string" && k && !eids.includes(k)) eids.push(k);
  };
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
    } else if (isRecord(o)) {
      for (const [key, val] of Object.entries(o)) {
        if (/resultgroup/i.test(key) && Array.isArray(val)) {
          for (const g of val) if (isRecord(g)) push(g.key);
        }
        walk(val);
      }
    }
  };
  walk(getList);
  return eids;
}

/** phase_test_results: full list + per-order details keyed by eorderid. */
export async function testResults(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== test results: list + per-order details ==");
  const r = await ctx.mc.api("api/test-results/GetList", {
    groupType: "UNINITIALIZED",
    searchString: "",
    maxResults: 9999,
  });
  if (r.json != null) {
    await ctx.store.saveJson("structured/test-results/GetList.json", r.json);
  }
  ctx.rec("test-results", "GetList", r); // always — a failed list must show up in gaps
  // Keys come straight from the list payload (newResultGroups[].key on every
  // instance seen so far) — no page load, works identically in every mode.
  const eids = eorderidsFromList(r.json);
  await ctx.store.saveJson("structured/test-results/_detail_links.json", eids);
  ctx.log(`  detail links: ${eids.length}`);
  if (eids.length === 0) {
    // Distinguish "the list answered but its shape hid the keys" (an exporter
    // gap worth reporting upstream) from "the list itself failed".
    const answered = isRecord(r.json) && Object.keys(r.json).length > 0;
    ctx.rec(
      "test-results",
      "GetDetails",
      null,
      answered
        ? `no eorderids in GetList payload (top keys: ${topKeys(r.json)})`
        : "no eorderids found (list empty/failed)",
      answered ? { outcome: "shape-mismatch" } : {},
    );
    return;
  }
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
    try {
      const d = await ctx.mc.api("api/test-results/GetDetails", {
        orderKey: eid,
        organizationID: "",
        PageNonce: ctx.nonce,
      });
      if (d.json != null) {
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
          detail,
        });
        saved++;
        guard.ok();
      } else {
        guard.fail();
      }
    } catch (e) {
      guard.fail();
      ctx.log(`   detail err ${e}`);
    }
  }
  ctx.rec("test-results", "GetDetails", { status: 200, body: "" }, `${saved}/${eids.length} orders`);
}
