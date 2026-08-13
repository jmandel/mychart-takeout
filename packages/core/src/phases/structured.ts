import { CLASSIC, SIMPLE, type SimpleBody } from "../catalog";
import type { PhaseCtx } from "../ctx";

function resolveBody(body: SimpleBody, ctx: PhaseCtx): Record<string, unknown> {
  if (body === "NONCE") return { PageNonce: ctx.nonce };
  if (body === "UPCOMING") return { selectedOrderID: "", PageNonce: ctx.nonce };
  if (body === "ITEMFEED") return { timeZone: ctx.timeZone, feedHost: 1, conditionViewHfrID: "" };
  return body;
}

/** phase_structured: single-call SIMPLE endpoints + CLASSIC form/get/nobody. */
export async function structured(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== structured: single-call domains ==");
  for (const { domain, path, body } of SIMPLE) {
    try {
      const r = await ctx.mc.api(path, resolveBody(body, ctx));
      const name = path.split("api/")[1]!.replace(/\//g, "__");
      await ctx.store.saveJson(
        `structured/${domain}/${name}.json`,
        r.json != null ? r.json : { _raw: r.body },
      );
      ctx.rec(domain, path.split("api/")[1]!, r);
    } catch (e) {
      ctx.log(`  ERR ${path} ${e}`);
    }
  }
  ctx.log("== structured: classic (form/get) domains ==");
  for (const { domain, path, form, kind } of CLASSIC) {
    try {
      const r =
        kind === "form" ? await ctx.mc.form(path, form)
        : kind === "nobody" ? await ctx.mc.nobody(path)
        : await ctx.mc.get(path);
      const name = path.split("?")[0]!.replace(/\//g, "__");
      if (r.json != null) {
        await ctx.store.saveJson(`structured/${domain}/${name}.json`, r.json);
        ctx.rec(domain, path, r);
      } else {
        // Some endpoints only return JSON when fetched from their own activity
        // page; cross-page they return the SPA shell. Don't save the shell —
        // the salvage phase (CDP driver) recovers the real JSON from the
        // network log while the dom phase visits the page.
        ctx.rec(domain, path, r, "shell-response (recovered via salvage/dom)");
      }
    } catch (e) {
      ctx.log(`  ERR ${path} ${e}`);
    }
  }
}
