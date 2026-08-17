import { CLASSIC, SIMPLE, type SimpleBody } from "../catalog";
import type { PhaseCtx } from "../ctx";
import { classifyError, classifyOutcome } from "../gaps";
import { findObservedAlternative } from "../heal";

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
    if (ctx.signal.aborted) return;
    // Name from the part after "api/" when present, else the whole path —
    // so non-api endpoints (e.g. Community/…, Authentication/…) work too.
    const rel = path.includes("api/") ? path.split("api/")[1]! : path;
    try {
      let r = await ctx.mc.api(path, resolveBody(body, ctx));
      let note = "";
      // Endpoint moved? If the app's own observed traffic knows this Method at
      // a different base, retry there ONCE and record the substitution.
      const oc = classifyOutcome(r);
      if ((oc === "not-found" || oc === "spa-shell") && ctx.observedApiPaths && !ctx.signal.aborted) {
        const alt = findObservedAlternative(path, ctx.client.prefix, ctx.observedApiPaths());
        if (alt) {
          const r2 = await ctx.mc.api(alt, resolveBody(body, ctx));
          if (r2.json != null) {
            r = r2;
            note = `substituted-path: ${alt}`;
          }
        }
      }
      // Only JSON lands in structured/ — a redirect can 200 into a huge HTML
      // error page, and saving that as "data" makes a failed domain look
      // populated (observed in the field: 4 × 403KB "Page Not Found" pages).
      // The rec below still puts the failure in the manifest + gaps report.
      if (r.json != null) {
        const name = rel.replace(/\//g, "__");
        await ctx.store.saveJson(`structured/${domain}/${name}.json`, r.json);
      }
      ctx.rec(domain, rel, r, note);
    } catch (e) {
      ctx.log(`  ERR ${path} ${e}`);
      ctx.rec(domain, rel, null, String(e).slice(0, 200), { outcome: classifyError(e) });
    }
  }
  ctx.log("== structured: classic (form/get) domains ==");
  for (const { domain, path, form, kind } of CLASSIC) {
    if (ctx.signal.aborted) return;
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
      ctx.rec(domain, path, null, String(e).slice(0, 200), { outcome: classifyError(e) });
    }
  }
}
