/**
 * Golden tests for the report builder port. Every golden below was verified
 * byte-identical to harness/build_reportlib.py run on the same fixture data
 * (Python 3, 2026-08-13) before being frozen here.
 */
import { describe, expect, test } from "bun:test";
import { buildReport } from "../../src/report/index";
import { ExportStore } from "../../src/store";
import { MemorySink, fixtureStore } from "./fixtures";

const TODAY = "2026-08-13";

// Pin an explicit source so goldens aren't coupled to the default label.
const SRC = "Epic MyChart (test.example.org)";

async function runFull() {
  const sink = new MemorySink();
  const store = fixtureStore(sink);
  const logs: string[] = [];
  await buildReport(store, { today: TODAY, source: SRC, log: (m) => logs.push(m) });
  return { sink, store, logs };
}

// Verified byte-identical to the Python output (join with \n, no trailing newline).
const GOLDEN_MD = [
  "# Patient Health Record Summary",
  "",
  "*Consolidated from Epic MyChart (test.example.org). Generated 2026-08-13.*",
  "*Method: Authenticated MyChart internal JSON API + rendered documents, captured via CDP.*",
  "",
  "## Patient",
  "",
  "- **Name (first):** Alex",
  "- **Date of birth:** 1/1/1992",
  "- **Age:** 34 yrs",
  "- **Height:** 5' 10\" (recorded 01/02/2026)",
  "- **Weight:** 170 lb (recorded 01/02/2026)",
  "- **Address:** 123 Main St, Springfield, IL 62704",
  "- **Email:** alex@example.com",
  "- **Phone:** 555-0100",
  "",
  "## Problem List",
  "",
  "- Asthma  *(noted 5/1/2010)*",
  "- Hypertension, essential",
  "",
  "## Allergies",
  "",
  "- **Penicillin** **[SEVERE]** — Hives  *(noted 2/3/2015)*",
  "- **Peanut, raw** — Anaphylaxis, severe",
  "",
  "## Medications",
  "",
  "- **Albuterol HFA** — 2 puffs q4h PRN  ",
  "  *prescribed 6/1/2026 by Dr. Chen*",
  "- **Lisinopril** — 10 mg daily  ",
  "  *prescribed 5/1/2026 by Dr. Patel*",
  "",
  "## Immunizations",
  "",
  "- **COVID-19 mRNA**: 3/1/2021, 4/1/2021",
  "- **Influenza**: 10/15/2025",
  "",
  "## Test & Imaging Results",
  "",
  "2 result orders with component values, reference ranges, and narratives (full JSON in `structured/test-results/details/`; flat rows in `indexes/test_result_components.csv`).",
  "",
  "### CBC With Differential  ",
  "*7/1/2026 8:00 AM · Dr. Chen*",
  "",
  "| Component | Value | Units | Reference | Flag |",
  "|---|---|---|---|---|",
  "| WBC | 12.1 | K/uL | 4.0 - 11.0 | High |",
  "| HGB | 14.0 | g/dL | 13.0 - 17.0 |  |",
  "",
  "### MRI Brain  ",
  "*6/15/2026 · Dr. Patel*",
  "",
  "",
  "*(Radiology/pathology narrative in the structured detail JSON.)*",
  "",
  "## Encounters / Visits",
  "",
  "2 encounters. Each has an After-Visit Summary in `structured/visits/avs/` and, where available, clinical notes in `structured/visits/notes/`.",
  "",
  "| Date | Type | Provider | AVS | Notes |",
  "|---|---|---|---|---|",
  "| 7/1/2026 | Office Visit | Dr. Chen | ✓ | 2 |",
  "| 6/1/2026 | Telehealth |  |  |  |",
  "",
  "## Messages",
  "",
  "2 conversation threads / 5 messages (full HTML bodies in `structured/messages/threads_full/`).",
  "",
  "---",
  "*See `README.md` for structure, sources, and limitations.*",
].join("\n");

describe("report builder (golden, python-verified)", () => {
  test("PATIENT_SUMMARY.md is byte-exact", async () => {
    const { sink } = await runFull();
    expect(sink.files.get("PATIENT_SUMMARY.md")).toBe(GOLDEN_MD);
  });

  test("test_result_components.csv is byte-exact (CRLF, minimal quoting)", async () => {
    const { sink } = await runFull();
    expect(sink.files.get("indexes/test_result_components.csv")).toBe(
      "order,date,name,value,units,range,flag\r\n" +
        "CBC With Differential,7/1/2026 8:00 AM,WBC,12.1,K/uL,4.0 - 11.0,High\r\n" +
        "CBC With Differential,7/1/2026 8:00 AM,HGB,14.0,g/dL,13.0 - 17.0,\r\n",
    );
  });

  test("problems.csv quotes comma-containing fields", async () => {
    const { sink } = await runFull();
    expect(sink.files.get("indexes/problems.csv")).toBe(
      "name,noted\r\nAsthma,5/1/2010\r\n\"Hypertension, essential\",\r\n",
    );
  });

  test("allergies/encounters CSVs render python booleans and None", async () => {
    const { sink } = await runFull();
    expect(sink.files.get("indexes/allergies.csv")).toBe(
      "name,reactions,severe,noted\r\n" +
        "Penicillin,Hives,True,2/3/2015\r\n" +
        '"Peanut, raw","Anaphylaxis, severe",False,\r\n',
    );
    expect(sink.files.get("indexes/encounters.csv")).toBe(
      "date,type,provider,avs,notes\r\n" +
        "7/1/2026,Office Visit,Dr. Chen,True,2\r\n" +
        "6/1/2026,Telehealth,,False,0\r\n",
    );
  });

  test("MANIFEST.json counts and records", async () => {
    const { sink } = await runFull();
    const man = JSON.parse(sink.files.get("MANIFEST.json")!);
    expect(man).toMatchObject({
      generated: TODAY,
      source: SRC,
      file_counts_by_top_dir: { "PATIENT_SUMMARY.json": 1, indexes: 8, "PATIENT_SUMMARY.md": 1 },
      total_files: 10,
      record_counts: {
        problems: 2,
        allergies: 2,
        immunizations: 2,
        medications: 2,
        test_result_orders: 2,
        encounters: 2,
        message_threads: 2,
        messages: 5,
      },
    });
    // Size accounting: a huge export must explain itself — where the bytes
    // live and which single files dominate.
    expect(man.total_bytes).toBeGreaterThan(0);
    expect(Object.keys(man.bytes_by_top_dir)).toContain("indexes");
    expect(man.largest_files.length).toBeGreaterThan(0);
    expect(man.largest_files[0].bytes).toBeGreaterThanOrEqual(man.largest_files.at(-1).bytes);
    for (const f of man.largest_files) {
      expect(typeof f.file).toBe("string");
      expect(typeof f.bytes).toBe("number");
    }
  });

  test("README.md contains the counts lines", async () => {
    const { sink } = await runFull();
    const readme = sink.files.get("README.md")!;
    expect(readme.startsWith("# MyChart Personal Health Record — Export\n")).toBe(true);
    expect(readme).toContain("- Problems: 2 · Allergies: 2 · Immunizations: 2 · Medications: 2");
    expect(readme).toContain("- Test/imaging result orders: 2 (components in `indexes/test_result_components.csv`)");
    expect(readme).toContain("- Message threads: 2 / 5 messages (`structured/messages/threads_full/`)");
    expect(readme.endsWith("was not published anywhere.\n")).toBe(true);
  });

  test("PATIENT_SUMMARY.json structure spot checks", async () => {
    const { sink } = await runFull();
    const S = JSON.parse(sink.files.get("PATIENT_SUMMARY.json")!);
    expect(Object.keys(S)).toEqual([
      "generated", "source", "method", "patient", "problems", "allergies",
      "immunizations", "medications", "histories", "test_results", "encounters", "messages",
    ]);
    expect(S.patient.firstName).toBe("Alex");
    expect(S.patient.age).toBe("34 yrs");
    expect(S.problems[1]).toEqual({ name: "Hypertension, essential", noted: null });
    expect(S.medications.map((m: { provider: unknown }) => m.provider)).toEqual(["Dr. Chen", "Dr. Patel"]);
    expect(S.test_results[0].components[1].flag).toBe(""); // "Unknown" → ""
    expect(S.test_results[1].has_narrative).toBe(true);
    expect(S.messages.subjects).toEqual(["Lab results question", "Refill request"]);
  });

  test("log callback gets the python-parity summary line", async () => {
    const { logs } = await runFull();
    expect(logs).toEqual([
      "  patient=Alex problems=2 allergies=2 imm=2 meds=2 results=2 encounters=2 threads=2",
    ]);
  });
});

describe("report builder on an empty store", () => {
  test("degrades to defaults without throwing (python-verified)", async () => {
    const sink = new MemorySink();
    const logs: string[] = [];
    await buildReport(new ExportStore(sink), { today: TODAY, log: (m) => logs.push(m) });
    const md = sink.files.get("PATIENT_SUMMARY.md")!;
    expect(md.match(/\*\(none\)\*/g)?.length).toBe(2); // problems + medications
    expect(md).toContain("0 result orders with component values");
    expect(md).toContain("0 encounters.");
    expect(md).toContain("0 conversation threads / 0 messages");
    const man = JSON.parse(sink.files.get("MANIFEST.json")!);
    expect(man.total_files).toBe(10);
    expect(man.record_counts.problems).toBe(0);
    expect(sink.files.get("indexes/problems.csv")).toBe("name,noted\r\n");
    expect(logs[0]).toBe(
      "  patient= problems=0 allergies=0 imm=0 meds=0 results=0 encounters=0 threads=0",
    );
  });
});
