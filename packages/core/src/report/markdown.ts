/** PATIENT_SUMMARY.md renderer (_write_markdown in the Python). */
import type { Summary, TestComponent } from "./summary";
import { pyGet, pyStr, truthy } from "./pysem";

/** Python `x or ''` in an interpolation slot. */
const orEmpty = (v: unknown): string => (truthy(v) ? pyStr(v) : "");

function componentRow(c: TestComponent): string {
  return `| ${pyStr(c.name)} | ${pyStr(c.value)} | ${orEmpty(c.units)} | ${orEmpty(c.range)} | ${pyStr(c.flag)} |`;
}

export function renderMarkdown(S: Summary): string {
  const p = S.patient;
  const o: string[] = [];
  const w = (x = ""): void => {
    o.push(x);
  };
  w("# Patient Health Record Summary"); w();
  w(`*Consolidated from ${S.source}. Generated ${S.generated}.*`);
  w(`*Method: ${S.method}.*`); w();
  w("## Patient"); w();
  w(`- **Name (first):** ${pyStr(p.firstName)}`);
  w(`- **Date of birth:** ${pyStr(p.dateOfBirth)}`);
  w(`- **Age:** ${pyStr(p.age)}`);
  if (truthy(p.height)) w(`- **Height:** ${pyGet(p.height, "value")} (recorded ${pyGet(p.height, "dateRecorded")})`);
  if (truthy(p.weight)) w(`- **Weight:** ${pyGet(p.weight, "value")} (recorded ${pyGet(p.weight, "dateRecorded")})`);
  if (truthy(p.address)) w(`- **Address:** ${p.address.map(pyStr).join(", ")}`);
  if (truthy(p.email)) w(`- **Email:** ${pyStr(p.email)}`);
  if (truthy(p.mobilePhone) || truthy(p.homePhone)) {
    w(`- **Phone:** ${pyStr(p.mobilePhone)} ${pyStr(p.homePhone)}`.trim());
  }
  w();
  w("## Problem List"); w();
  for (const x of S.problems) w(`- ${pyStr(x.name)}` + (truthy(x.noted) ? `  *(noted ${pyStr(x.noted)})*` : ""));
  if (S.problems.length === 0) w("*(none)*");
  w(); w("## Allergies"); w();
  for (const a of S.allergies) {
    const sev = truthy(a.severe) ? " **[SEVERE]**" : "";
    const rx = a.reactions.some(truthy) ? " — " + a.reactions.filter(truthy).map(pyStr).join(", ") : "";
    w(`- **${pyStr(a.name)}**${sev}${rx}` + (truthy(a.noted) ? `  *(noted ${pyStr(a.noted)})*` : ""));
  }
  w(); w("## Medications"); w();
  for (const m of S.medications) {
    w(`- **${pyStr(m.name)}** — ${pyStr(m.sig)}  \n  *prescribed ${pyStr(m.date)} by ${pyStr(m.provider)}*`);
  }
  if (S.medications.length === 0) w("*(none)*");
  w(); w("## Immunizations"); w();
  for (const i of S.immunizations) w(`- **${pyStr(i.name)}**: ${i.dates.map(pyStr).join(", ")}`);
  w(); w("## Test & Imaging Results"); w();
  w(
    `${S.test_results.length} result orders with component values, reference ranges, and narratives ` +
      `(full JSON in \`structured/test-results/details/\`; flat rows in \`indexes/test_result_components.csv\`).`,
  ); w();
  for (const r of S.test_results) {
    w(`### ${pyStr(r.name)}  \n*${pyStr(r.date)} · ${pyStr(r.provider)}*`); w();
    if (r.components.length > 0) {
      w("| Component | Value | Units | Reference | Flag |"); w("|---|---|---|---|---|");
      for (const c of r.components) w(componentRow(c));
    }
    if (r.has_narrative) w("\n*(Radiology/pathology narrative in the structured detail JSON.)*");
    w();
  }
  w("## Encounters / Visits"); w();
  w(
    `${S.encounters.length} encounters. Each has an After-Visit Summary in \`structured/visits/avs/\` ` +
      `and, where available, clinical notes in \`structured/visits/notes/\`.`,
  ); w();
  w("| Date | Type | Provider | AVS | Notes |"); w("|---|---|---|---|---|");
  for (const e of S.encounters) {
    w(`| ${pyStr(e.date)} | ${pyStr(e.type)} | ${orEmpty(e.provider)} | ${truthy(e.avs) ? "✓" : ""} | ${orEmpty(e.notes)} |`);
  }
  w(); w("## Messages"); w();
  w(
    `${S.messages.threads} conversation threads / ${S.messages.total_messages} messages ` +
      `(full HTML bodies in \`structured/messages/threads_full/\`).`,
  );
  w(); w("---"); w("*See `README.md` for structure, sources, and limitations.*");
  return o.join("\n");
}
