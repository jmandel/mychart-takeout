import type { PhaseCtx } from "../ctx";
import { anyTrueDeep, collectStrings, isRecord, pad2 } from "../util";
import { pyTruthy } from "./common";

type VisitMeta = Record<string, unknown>;

/** _visit_meta_map: walk saved visit-list JSON for per-CSN display metadata. */
function visitMetaMap(docs: unknown[]): Record<string, VisitMeta> {
  const meta: Record<string, VisitMeta> = {};
  const walk = (o: unknown): void => {
    if (isRecord(o)) {
      if (o.Csn && ("PrimaryDate" in o || "VisitTypeName" in o)) {
        const pd = o.PrimaryDepartment;
        meta[String(o.Csn)] = {
          date: o.PrimaryDate,
          type: o.VisitTypeName,
          provider: o.PrimaryProviderName,
          dept: isRecord(pd) ? pd.Name : pd,
          noteAvail: o.IsClinicalNoteAvailable,
          avsAvail: o.IsVisitSummaryEnabled,
        };
      }
      for (const v of Object.values(o)) walk(v);
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v);
    }
  };
  for (const d of docs) walk(d);
  return meta;
}

/** phase_visits: upcoming + paginated past lists, then per-CSN AVS + notes. */
export async function visits(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== visits: list + AVS + notes ==");
  // upcoming (token-as-header, no body)
  try {
    const r = await ctx.mc.nobody(
      `Visits/VisitsList/LoadUpcoming?timeZone=${encodeURIComponent(ctx.timeZone)}&ComponentNumber=5&noCache=${ctx.nonce}`,
    );
    await ctx.store.saveJson(
      "structured/visits/upcoming.json",
      r.json != null ? r.json : { _raw: r.body },
    );
    ctx.rec("visits", "LoadUpcoming", r);
  } catch (e) {
    ctx.log(`  ERR upcoming ${e}`);
  }
  // past (paginate serializedIndex)
  let sidx = "";
  let page = 0;
  for (;;) {
    page += 1;
    const url =
      `Visits/VisitsList/LoadPast?loadpast=1&searchString=&oldestRenderedDate=` +
      `&ComponentNumber=7&serializedIndex=${sidx}&noCache=${ctx.nonce}${page}`;
    const r = await ctx.mc.nobody(url);
    const j = r.json;
    ctx.rec("visits", `LoadPast[p${page}]`, r);
    if (!pyTruthy(j)) break;
    await ctx.store.saveJson(`structured/visits/past_page_${page}.json`, j);
    const nxt = isRecord(j) && typeof j.SerializedIndex === "string" ? j.SerializedIndex : "";
    // HasMoreData is a bool nested per-org; detect any true
    const more = anyTrueDeep(j, "hasmoredata");
    if (!more || !nxt || nxt === sidx || page > 60) break;
    sidx = nxt;
  }
  // AVS + notes per CSN
  const docs = ctx.store.listJson("structured/visits/past_page_").map(([, v]) => v);
  const upcoming = ctx.store.getJson("structured/visits/upcoming.json");
  if (upcoming !== undefined) docs.push(upcoming);
  const meta = visitMetaMap(docs);
  const csns: string[] = [];
  for (const d of docs) {
    for (const c of collectStrings(d, "Csn")) if (!csns.includes(c)) csns.push(c);
  }
  await ctx.store.saveJson("structured/visits/_all_csns.json", csns);
  const index: Record<string, unknown>[] = [];
  for (let i = 0; i < csns.length; i++) {
    const csn = csns[i]!;
    const m = meta[csn] ?? {};
    const label = `${m.date ?? "?"} ${m.type ?? ""} ${m.provider ?? ""}`.trim();
    const e: Record<string, unknown> = { idx: i, csn, meta: m, avs_bytes: 0, notes: 0 };
    try {
      const a = await ctx.mc.api("api/report-content/LoadReportContent", {
        reportMnemonic: "AMB_AVS",
        reportID: "",
        csn,
        isFullReportPage: false,
        uniqueClass: "EID-1",
        nonce: ctx.nonce,
      });
      const aj = a.json;
      if (isRecord(aj) && typeof aj.reportContent === "string" && aj.reportContent) {
        const css = typeof aj.reportCss === "string" ? aj.reportCss : "";
        await ctx.store.saveText(
          `structured/visits/avs/${pad2(i)}.html`,
          `<!-- CSN ${csn} | ${label} -->\n<style>${css}</style>\n` + aj.reportContent,
        );
        e.avs_bytes = aj.reportContent.length;
      }
    } catch (ex) {
      e.avs_err = String(ex);
    }
    try {
      const nr = await ctx.mc.api("api/visit-notes/GetVisitNotes", { CSN: csn, FromPvdPage: true });
      const j = isRecord(nr.json) ? nr.json : {};
      await ctx.store.saveJson(`structured/visits/visitnotes_meta/${pad2(i)}.json`, {
        csn,
        meta: m,
        resp: j,
      });
      const lrp = j.lrpID ?? "";
      const noteList = Array.isArray(j.noteList) ? j.noteList : [];
      for (let ni = 0; ni < noteList.length; ni++) {
        const note = isRecord(noteList[ni]) ? (noteList[ni] as Record<string, unknown>) : {};
        try {
          const rn = await ctx.mc.api("api/report-content/LoadReportContent", {
            reportMnemonic: "OPEN_NOTES",
            reportID: lrp,
            contextID: note.hnoID ?? "",
            contextDAT: note.hnoDAT ?? "",
            contextINI: "HNO",
            csn,
            isFullReportPage: false,
            uniqueClass: "EID-1",
            nonce: ctx.nonce,
          });
          const nj = rn.json;
          if (isRecord(nj) && typeof nj.reportContent === "string" && nj.reportContent) {
            const css = typeof nj.reportCss === "string" ? nj.reportCss : "";
            await ctx.store.saveText(
              `structured/visits/notes/${pad2(i)}_${ni}.html`,
              `<!-- CSN ${csn} | ${label} | ${note.displayName ?? ""} ${note.provider ?? ""} ${note.iso ?? ""} -->\n` +
                `<style>${css}</style>\n` +
                nj.reportContent,
            );
            e.notes = (e.notes as number) + 1;
          }
        } catch {
          // per-note errors ignored (as in export.py)
        }
      }
    } catch (ex) {
      e.notes_err = String(ex);
    }
    index.push(e);
    ctx.log(
      `  [${pad2(i)}] ${label.slice(0, 44).padEnd(44)} AVS=${String(e.avs_bytes).padStart(6)}b notes=${e.notes}`,
    );
  }
  await ctx.store.saveJson("structured/visits/_visit_index.json", index);
  const avsCount = index.filter((x) => (x.avs_bytes as number) > 0).length;
  const noteCount = index.reduce((s, x) => s + (x.notes as number), 0);
  ctx.rec("visits", "AVS+notes", { status: 200, body: "" }, `${avsCount} AVS, ${noteCount} notes`);
}
