/** indexes/*.csv writers (wcsv in the Python). */
import type { Summary } from "./summary";
import { getD, truthy } from "./pysem";

/**
 * Python csv module value rendering: None → empty string, booleans render as
 * True/False (capitalized — kept for byte-parity with the reference output),
 * everything else via str().
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** QUOTE_MINIMAL: quote only fields containing delimiter/quote/CR/LF. */
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/** DictWriter(extrasaction="ignore") with CRLF terminator after every row. */
export function renderCsv(rows: Record<string, unknown>[], cols: string[]): string {
  const lines: string[] = [cols.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => csvField(csvCell(c in r ? r[c] : ""))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** The eight index CSVs, in the Python write order. */
export function renderIndexCsvs(
  S: Summary,
  threadIndex: unknown[],
  compRows: Record<string, unknown>[],
): [name: string, text: string][] {
  const allergyRows = S.allergies.map((a) => ({
    ...a,
    reactions: a.reactions.filter(truthy).map(String).join(", "),
  }));
  const immRows = S.immunizations.map((i) => ({ name: i.name, dates: i.dates.map(String).join("; ") }));
  const trRows = S.test_results.map((r) => ({
    name: r.name,
    date: r.date,
    provider: r.provider,
    components: r.num_components,
    has_narrative: r.has_narrative,
  }));
  const msgRows = threadIndex.map((m) => ({
    subject: getD(m, "subject"),
    tag: getD(m, "tag"),
    messages: getD(m, "full_msgs"),
  }));
  return [
    ["problems.csv", renderCsv(S.problems.map((p) => ({ ...p })), ["name", "noted"])],
    ["allergies.csv", renderCsv(allergyRows, ["name", "reactions", "severe", "noted"])],
    ["immunizations.csv", renderCsv(immRows, ["name", "dates"])],
    ["medications.csv", renderCsv(S.medications.map((m) => ({ ...m })), ["name", "sig", "date", "provider"])],
    ["test_results.csv", renderCsv(trRows, ["name", "date", "provider", "components", "has_narrative"])],
    ["test_result_components.csv", renderCsv(compRows, ["order", "date", "name", "value", "units", "range", "flag"])],
    ["encounters.csv", renderCsv(S.encounters.map((e) => ({ ...e })), ["date", "type", "provider", "avs", "notes"])],
    ["messages.csv", renderCsv(msgRows, ["subject", "tag", "messages"])],
  ];
}
