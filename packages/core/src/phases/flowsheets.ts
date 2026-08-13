import type { PhaseCtx } from "../ctx";
import { isRecord, pad2, slug } from "../util";
import { pyTruthy } from "./common";

const FLOWSHEETS_REL = "structured/track-my-health/track-my-health__GetFlowsheets.json";

/** phase_flowsheets: paginate every patient-tracked flowsheet's readings. */
export async function flowsheets(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== flowsheets (patient-tracked vitals) ==");
  const f = ctx.store.getJson(FLOWSHEETS_REL);
  if (f === undefined) {
    throw new Error(`flowsheets: ${FLOWSHEETS_REL} not in store (run the structured phase first)`);
  }
  const fls = isRecord(f) && Array.isArray(f.flowsheets) ? f.flowsheets : [];
  for (let fi = 0; fi < fls.length; fi++) {
    const fl = isRecord(fls[fi]) ? (fls[fi] as Record<string, unknown>) : {};
    const eid = fl.episodeId || fl.templateId;
    const nameRaw = "name" in fl ? fl.name : "flowsheet";
    const name = slug(typeof nameRaw === "string" ? nameRaw : null);
    let endIso = "";
    const seen = new Set<string>();
    for (let page = 0; page < 40; page++) {
      const r = await ctx.mc.api("api/track-my-health/GetFlowsheetReadings", {
        episodeId: eid,
        endInstantIso: endIso,
        numReadings: 1000,
      });
      const j = r.json;
      if (!pyTruthy(j)) break;
      await ctx.store.saveJson(
        `structured/track-my-health/readings/${pad2(fi)}_${name}_p${page}.json`,
        j,
      );
      // pagination cursor: oldest ISO timestamp seen anywhere in the payload
      const isos = new Set(JSON.stringify(j).match(/"\d{4}-\d\d-\d\dT[\d:]+"/g) ?? []);
      const fresh = [...isos].some((x) => !seen.has(x));
      if (!fresh) break;
      for (const x of isos) seen.add(x);
      const oldest = [...isos].sort()[0]!.replace(/"/g, "");
      if (oldest === endIso) break;
      endIso = oldest;
    }
  }
  ctx.rec(
    "track-my-health",
    "GetFlowsheetReadings",
    { status: 200, body: "" },
    `${fls.length} flowsheets`,
  );
}
