import { unzipSync } from "fflate";
import type { PhaseCtx } from "../ctx";
import { isRecord } from "../util";

/** Ready-to-download 'all visit records' (VDT) release records. */
function readyRecords(j: unknown): Record<string, unknown>[] {
  const recs: Record<string, unknown>[] = [];
  const walk = (o: unknown): void => {
    if (isRecord(o)) {
      if (o.releaseId && o.documentId && String(o.isDownloadable) === "1" && o.type === "VDT") {
        recs.push(o);
      }
      for (const v of Object.values(o)) walk(v);
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v);
    }
  };
  walk(j);
  return recs;
}

async function getReady(ctx: PhaseCtx): Promise<Record<string, unknown>[]> {
  const r = await ctx.mc.api("api/requested-records/GetReleaseRecords", {});
  return readyRecords(r.json ?? {});
}

/**
 * phase_ccda: C-CDA "all visits" export (standards-format IHE-XDM ZIP).
 * Server-side generation is ASYNC: reuse a ready package if one exists, else
 * request generation and poll the Requested-Records list, then download the
 * ZIP bytes and extract them.
 */
export async function ccda(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== C-CDA all-visits export ==");
  let recs = await getReady(ctx);
  if (recs.length === 0) {
    ctx.log("  none ready; requesting generation…");
    await ctx.mc.api("api/record-download/GetDownloadStarted", {
      mode: "allVisits",
      csn: "",
      startDate: "",
      endDate: "",
      documentPassword: "",
      passwordVerify: "",
      encCount: "",
      encDate: "",
      doEncrypt: "false",
    });
    for (let k = 0; k < 30 && recs.length === 0; k++) {
      await ctx.wait(4000);
      recs = await getReady(ctx);
    }
  }
  if (recs.length === 0) {
    ctx.rec("ccda", "download", { status: 0, body: "" }, "generation not ready (timed out)");
    return;
  }
  const rec0 = recs[0]!;
  const q = new URLSearchParams({
    releaseId: String(rec0.releaseId),
    docId: String(rec0.documentId),
    downloadedFileName: "packageName" in rec0 ? String(rec0.packageName) : "record.zip",
  });
  const { status, bytes } = await ctx.client.fetchBytes(
    `${ctx.client.prefix}/Documents/Released/Download?${q}`,
  );
  if (status === 200 && bytes.length > 0) {
    await ctx.store.saveBytes("documents/ccda/HealthSummary_all_visits_CCDA.zip", bytes);
    let n = 0;
    try {
      const files = unzipSync(bytes);
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith("/")) continue;
        await ctx.store.saveBytes(`documents/ccda/extracted/${name}`, data);
        if (name.toUpperCase().endsWith(".XML")) n++;
      }
    } catch {
      n = 0;
    }
    ctx.rec(
      "ccda",
      "download",
      { status: 200, body: "" },
      `${bytes.length} bytes, ${n} C-CDA docs -> documents/ccda/`,
    );
  } else {
    ctx.rec("ccda", "download", { status, body: "" }, "empty response");
  }
}
