import type { ExportStore } from "../store";
import { renderIndexCsvs } from "./csv";
import { renderManifest } from "./manifest";
import { renderMarkdown } from "./markdown";
import { renderReadme } from "./readme";
import { buildSummary, summaryLogLine } from "./summary";

export type { Summary } from "./summary";

export interface ReportOpts {
  /** ISO date for "generated" stamps; injected for deterministic tests. */
  today: string;
  source?: string;
  method?: string;
  /** Receives the Python-parity end-of-report summary line. */
  log?: (msg: string) => void;
}

/**
 * Deterministic report builder — port of harness/build_reportlib.py.
 * Reads structured JSON from the store (memory), writes PATIENT_SUMMARY.md/
 * .json, indexes/*.csv, MANIFEST.json, README.md through the store's sink,
 * in the same order as the Python (manifest counts files saved so far, and
 * therefore excludes MANIFEST.json itself and README.md — same as the
 * reference, which walks the directory before writing them).
 */
export async function buildReport(store: ExportStore, opts: ReportOpts): Promise<void> {
  const { S, threadIndex, compRows } = buildSummary(store, {
    today: opts.today,
    source: opts.source ?? "Epic MyChart",
    method: opts.method ?? "Authenticated MyChart internal JSON API + rendered documents, captured via CDP",
  });
  await store.saveText("PATIENT_SUMMARY.json", JSON.stringify(S, null, 2));
  for (const [name, text] of renderIndexCsvs(S, threadIndex, compRows)) {
    await store.saveText(`indexes/${name}`, text);
  }
  await store.saveText("PATIENT_SUMMARY.md", renderMarkdown(S));
  await store.saveText("MANIFEST.json", renderManifest(S, [...store.savedFiles]));
  await store.saveText("README.md", renderReadme(S));
  opts.log?.(summaryLogLine(S));
}
