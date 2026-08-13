/** Synthetic "Alex Example" patient — no real PHI. Shapes mirror the MyChart
 * API responses that build_reportlib.py navigates. */
import type { Sink } from "../../src/types";
import { ExportStore } from "../../src/store";

export class MemorySink implements Sink {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async saveText(rel: string, text: string): Promise<void> {
    this.files.set(rel, text);
  }
  async saveBytes(rel: string, b: Uint8Array): Promise<void> {
    this.bytes.set(rel, b);
  }
}

export const FIXTURES: Record<string, unknown> = {
  "structured/health-summary/health-summary__FetchHealthSummary.json": {
    patientFirstName: "Alex",
    header: {
      patientAge: " 34 yrs ",
      height: { value: "5' 10\"", dateRecorded: "01/02/2026" },
      weight: { value: "170 lb", dateRecorded: "01/02/2026" },
      bloodType: "O+",
    },
  },
  "structured/personal-info/personalInformation__GetContactInformation.json": {
    currentValues: {
      address: { formattedValues: ["123 Main St", "Springfield, IL 62704"] },
      email: { value: "alex@example.com" },
      mobilePhone: { formattedValue: "555-0100" },
      homePhone: {},
    },
  },
  "structured/allergies/allergies__LoadAllergies.json": {
    dateOfBirth: "1/1/1992",
    dataList: [
      {
        allergyItem: {
          name: "Penicillin",
          reactionList: [{ title: "Hives" }, { title: null }],
          isSevere: true,
          formattedDateNoted: "2/3/2015",
        },
      },
      {
        allergyItem: {
          name: "Peanut, raw",
          reactionList: [{ title: "Anaphylaxis, severe" }],
          isSevere: false,
        },
      },
    ],
  },
  "structured/health-issues/HealthIssues__LoadHealthIssuesData.json": {
    dataList: [
      { healthIssueItem: { name: "Asthma", formattedDateNoted: "5/1/2010" } },
      { healthIssueItem: { name: "Hypertension, essential" } },
    ],
  },
  "structured/immunizations/immunizations__LoadImmunizations.json": {
    organizationImmunizationList: [
      { orgImmunizations: [{ name: "COVID-19 mRNA", formattedAdministeredDates: ["3/1/2021", "4/1/2021"] }] },
      { immunizations: [{ name: "Influenza", formattedAdministeredDates: ["10/15/2025"] }] },
    ],
  },
  "structured/medications/medications__LoadMedicationsPage.json": {
    medicationsLists: {
      active: [
        {
          prescriptions: [
            {
              name: "Albuterol HFA",
              sig: "2 puffs q4h PRN",
              dateToDisplay: "6/1/2026",
              authorizingProvider: { name: "Dr. Chen" },
            },
          ],
        },
      ],
      other: {
        prescriptions: [
          {
            name: "Lisinopril",
            sig: "10 mg daily",
            dateToDisplay: "5/1/2026",
            authorizingProvider: "Dr. Patel",
          },
        ],
      },
    },
  },
  "structured/histories/histories__LoadHistoriesViewModel.json": {
    surgical: [{ name: "Appendectomy", year: 2010 }],
  },
  "structured/test-results/details/00_CBC.json": {
    eorderid: "e1",
    detail: {
      results: [
        {
          name: "CBC With Differential",
          orderMetadata: { prioritizedInstantDisplay: "7/1/2026 8:00 AM", orderProviderName: "Dr. Chen" },
          resultComponents: [
            {
              componentInfo: { name: "WBC", units: "K/uL" },
              componentResultInfo: {
                value: "12.1",
                referenceRange: { formattedReferenceRange: "4.0 - 11.0" },
                abnormalFlagCategoryValue: "High",
              },
            },
            {
              componentInfo: { name: "HGB", units: "g/dL" },
              componentResultInfo: {
                value: "14.0",
                referenceRange: { formattedReferenceRange: "13.0 - 17.0" },
                abnormalFlagCategoryValue: "Unknown",
              },
            },
          ],
        },
      ],
    },
  },
  "structured/test-results/details_full/00_MRI.json": {
    eorderid: "e2",
    detail: {
      results: [
        {
          name: "MRI Brain",
          orderMetadata: { resultTimestampDisplay: "6/15/2026", orderProviderName: "Dr. Patel" },
          studyResult: {
            narrative: { contentAsString: "No acute findings. " },
            impression: { contentAsString: "Normal study." },
          },
        },
      ],
    },
  },
  "structured/visits/_visit_index.json": [
    {
      idx: 0,
      csn: "c1",
      meta: { date: "7/1/2026", type: "Office Visit", provider: "Dr. Chen" },
      avs_bytes: 1234,
      notes: 2,
    },
    {
      idx: 1,
      csn: "c2",
      meta: { date: "6/1/2026", type: "Telehealth", provider: null },
      avs_bytes: 0,
      notes: 0,
    },
  ],
  "structured/messages/_threads_full_index.json": [
    { hthId: "h1", subject: "Lab results question", tag: 1, full_msgs: 3 },
    { hthId: "h2", subject: "Refill request", tag: 2, full_msgs: 2 },
  ],
};

/** Store with all fixtures primed (as if phases had saved them this run). */
export function fixtureStore(sink: Sink = new MemorySink()): ExportStore {
  const store = new ExportStore(sink);
  for (const [rel, doc] of Object.entries(FIXTURES)) store.primeJson(rel, doc);
  return store;
}
