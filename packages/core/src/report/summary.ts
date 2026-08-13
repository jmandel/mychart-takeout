/** Port of build_reportlib.py build(): assemble the summary object S. */
import type { ExportStore } from "../store";
import { isRecord } from "../util";
import { asArr, asRec, getD, orElse, pyStr, truthy } from "./pysem";

export interface TestComponent {
  name: unknown;
  value: unknown;
  units: unknown;
  range: unknown;
  flag: unknown;
}

export interface TestResult {
  name: unknown;
  date: unknown;
  provider: unknown;
  num_components: number;
  components: TestComponent[];
  has_narrative: boolean;
}

export interface Encounter {
  date: unknown;
  type: unknown;
  provider: unknown;
  avs: boolean;
  notes: unknown;
}

export interface PatientBlock {
  firstName: unknown;
  age: string;
  dateOfBirth: unknown;
  height: unknown;
  weight: unknown;
  bloodType: unknown;
  address: unknown[];
  email: string;
  homePhone: string;
  mobilePhone: string;
}

/** Key order matters: PATIENT_SUMMARY.json must serialize like the Python S. */
export interface Summary {
  generated: string;
  source: string;
  method: string;
  patient: PatientBlock;
  problems: { name: unknown; noted: unknown }[];
  allergies: { name: unknown; reactions: unknown[]; severe: unknown; noted: unknown }[];
  immunizations: { name: unknown; dates: unknown[] }[];
  medications: { name: unknown; sig: unknown; date: unknown; provider: unknown }[];
  histories: unknown;
  test_results: TestResult[];
  encounters: Encounter[];
  messages: { threads: number; total_messages: number; subjects: string[] };
}

export interface SummaryMeta {
  today: string;
  source: string;
  method: string;
}

export interface SummaryBundle {
  S: Summary;
  /** Raw _threads_full_index.json rows (messages.csv reads these, not S). */
  threadIndex: unknown[];
  /** Flat per-component rows built during the details scan (for the CSV). */
  compRows: Record<string, unknown>[];
}

/** _L(): parsed JSON or default (missing file → default, like a read failure). */
function load(store: ExportStore, rel: string, dflt: unknown): unknown {
  const v = store.getJson(rel);
  return v === undefined ? dflt : v;
}

/** glob("<prefix>*.json") equivalent: direct children only, sorted by path. */
function directJsonUnder(store: ExportStore, prefix: string): [string, unknown][] {
  return store
    .listJson(prefix)
    .filter(([rel]) => rel.endsWith(".json") && !rel.slice(prefix.length).includes("/"));
}

/** Recursive "prescriptions" collector (findpx in the Python). */
function findPrescriptions(o: unknown): unknown[] {
  const out: unknown[] = [];
  if (isRecord(o)) {
    for (const [k, v] of Object.entries(o)) {
      if (k === "prescriptions" && Array.isArray(v)) out.push(...v);
      else out.push(...findPrescriptions(v));
    }
  } else if (Array.isArray(o)) {
    for (const v of o) out.push(...findPrescriptions(v));
  }
  return out;
}

export function buildSummary(store: ExportStore, meta: SummaryMeta): SummaryBundle {
  const ST = "structured/";
  const hs = asRec(load(store, ST + "health-summary/health-summary__FetchHealthSummary.json", {}));
  const contact = asRec(load(store, ST + "personal-info/personalInformation__GetContactInformation.json", {}));
  const allergiesRaw = asRec(load(store, ST + "allergies/allergies__LoadAllergies.json", {}));
  const cur = asRec(getD(contact, "currentValues", {}));
  const addr = asRec(getD(cur, "address", {}));

  const cv = (k: string): string => {
    const v = getD(cur, k, null);
    const picked = isRecord(v)
      ? orElse(getD(v, "value", null), orElse(getD(v, "formattedValue", null), ""))
      : orElse(v, "");
    return truthy(picked) ? String(picked) : "";
  };

  const header = asRec(orElse(getD(hs, "header", null), {}));
  const ageRaw = getD(header, "patientAge", "");
  const patient: PatientBlock = {
    firstName: getD(hs, "patientFirstName", ""),
    age: (typeof ageRaw === "string" ? ageRaw : pyStr(ageRaw)).trim(),
    dateOfBirth: getD(allergiesRaw, "dateOfBirth", ""),
    height: getD(header, "height", {}),
    weight: getD(header, "weight", {}),
    bloodType: getD(header, "bloodType", ""),
    address: asArr(getD(addr, "formattedValues", [])),
    email: cv("email") || cv("emailAddress"),
    homePhone: cv("homePhone"),
    mobilePhone: cv("mobilePhone") || cv("cellPhone"),
  };

  const hi = asRec(load(store, ST + "health-issues/HealthIssues__LoadHealthIssuesData.json", {}));
  const problems = asArr(getD(hi, "dataList", [])).map((x) => {
    const it = asRec(getD(x, "healthIssueItem", {}));
    return { name: getD(it, "name"), noted: getD(it, "formattedDateNoted") };
  });

  const allergies = asArr(getD(allergiesRaw, "dataList", [])).map((x) => {
    const it = asRec(getD(x, "allergyItem", {}));
    return {
      name: getD(it, "name"),
      reactions: asArr(getD(it, "reactionList", [])).map((r) => getD(r, "title")),
      severe: getD(it, "isSevere"),
      noted: getD(it, "formattedDateNoted"),
    };
  });

  const imm = asRec(load(store, ST + "immunizations/immunizations__LoadImmunizations.json", {}));
  const immunizations: { name: unknown; dates: unknown[] }[] = [];
  for (const org of asArr(getD(imm, "organizationImmunizationList", []))) {
    const list = orElse(getD(org, "orgImmunizations", null), orElse(getD(org, "immunizations", null), []));
    for (const i of asArr(list)) {
      immunizations.push({ name: getD(i, "name"), dates: asArr(getD(i, "formattedAdministeredDates", [])) });
    }
  }

  const med = load(store, ST + "medications/medications__LoadMedicationsPage.json", {});
  const medications = findPrescriptions(med).map((p) => {
    const ap = getD(p, "authorizingProvider");
    return {
      name: getD(p, "name"),
      sig: getD(p, "sig"),
      date: getD(p, "dateToDisplay"),
      provider: isRecord(ap) ? getD(ap, "name") : (ap as unknown),
    };
  });

  const histories = load(store, ST + "histories/histories__LoadHistoriesViewModel.json", {});

  const detailDocs = [
    ...directJsonUnder(store, ST + "test-results/details/"),
    ...directJsonUnder(store, ST + "test-results/details_full/"),
  ];
  const results: TestResult[] = [];
  const compRows: Record<string, unknown>[] = [];
  for (const [, doc] of detailDocs) {
    const det = asRec(getD(doc, "detail", {}));
    for (const r of asArr(getD(det, "results", []))) {
      const om = asRec(getD(r, "orderMetadata", {}));
      const date = orElse(getD(om, "prioritizedInstantDisplay"), getD(om, "resultTimestampDisplay"));
      const comps: TestComponent[] = [];
      for (const c of asArr(getD(r, "resultComponents", []))) {
        const ci = asRec(getD(c, "componentInfo", {}));
        const cri = asRec(getD(c, "componentResultInfo", {}));
        const rr = getD(asRec(orElse(getD(cri, "referenceRange"), {})), "formattedReferenceRange", "");
        const flag = getD(cri, "abnormalFlagCategoryValue");
        const comp: TestComponent = {
          name: getD(ci, "name"),
          value: getD(cri, "value"),
          units: getD(ci, "units"),
          range: rr,
          flag: flag === null || flag === "Unknown" ? "" : flag,
        };
        comps.push(comp);
        compRows.push({ order: getD(r, "name"), date, ...comp });
      }
      const study = asRec(getD(r, "studyResult", {}));
      let narr = "";
      for (const k of ["narrative", "impression"]) {
        const v = getD(study, k);
        if (isRecord(v) && truthy(getD(v, "contentAsString"))) narr += String(getD(v, "contentAsString"));
      }
      results.push({
        name: getD(r, "name"),
        date,
        provider: getD(om, "orderProviderName"),
        num_components: comps.length,
        components: comps,
        has_narrative: narr.trim().length > 0,
      });
    }
  }

  const vindex = asArr(load(store, ST + "visits/_visit_index.json", []));
  const encounters: Encounter[] = vindex.map((e) => {
    const m = asRec(getD(e, "meta", {}));
    return {
      date: getD(m, "date"),
      type: getD(m, "type"),
      provider: getD(m, "provider"),
      avs: truthy(getD(e, "avs_bytes")),
      notes: getD(e, "notes"),
    };
  });

  const threadIndex = asArr(load(store, ST + "messages/_threads_full_index.json", []));
  const subjects = [...new Set(threadIndex.map((m) => getD(m, "subject")).filter(truthy).map(String))].sort();
  const totalMessages = threadIndex.reduce<number>((t, m) => {
    const v = getD(m, "full_msgs");
    return t + (truthy(v) ? Number(v) : 0);
  }, 0);

  const S: Summary = {
    generated: meta.today,
    source: meta.source,
    method: meta.method,
    patient,
    problems,
    allergies,
    immunizations,
    medications,
    histories,
    test_results: results,
    encounters,
    messages: { threads: threadIndex.length, total_messages: totalMessages, subjects },
  };
  return { S, threadIndex, compRows };
}

/** The Python end-of-build console line, handed to opts.log. */
export function summaryLogLine(S: Summary): string {
  return (
    `  patient=${pyStr(S.patient.firstName)} problems=${S.problems.length} allergies=${S.allergies.length} ` +
    `imm=${S.immunizations.length} meds=${S.medications.length} results=${S.test_results.length} ` +
    `encounters=${S.encounters.length} threads=${S.messages.threads}`
  );
}
