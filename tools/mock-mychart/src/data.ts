/**
 * Synthetic patient "Alex Example" — entirely fictional, no real PHI.
 * Shapes mirror what the core phases and report builder navigate.
 */
import { zipSync } from "../../../packages/browser/src/zip";

/** The ONE token that authenticates this session's API calls. Classic builds
 *  serve it from /Home/CSRFToken; "PX" builds only embed it in the page. */
export const CSRF_TOKEN = "mock-csrf-token-1";

/** The token embedded in the LOGIN page's HTML. Every Epic instance we have
 *  looked at serves one there: it is shaped exactly like a session token and
 *  authenticates nothing. Adopting it is the trap that turns "signed out" into
 *  an export full of login pages. */
export const LOGIN_PAGE_TOKEN = "mock-login-page-token-authenticates-nothing";

/** A stale token that some pages carry BEFORE the live one (e.g. on a sign-out
 *  form), so "the first __RequestVerificationToken in the DOM" is the wrong
 *  one — and posting it is what trips the anti-CSRF session kill. */
export const STALE_PAGE_TOKEN = "mock-stale-page-token-authenticates-nothing";

export const CSRF_PAGE = `<!doctype html><html><body>
<form><input name="__RequestVerificationToken" type="hidden" value="${CSRF_TOKEN}" /></form>
</body></html>`;

/** Padding so the login page is the ~100KB of markup a real portal serves —
 *  big enough that "we got a big HTML page" is no evidence of being signed in. */
const LOGIN_FILLER = Array.from(
  { length: 340 },
  (_, i) =>
    `<div class="mc-login-panel" id="mc-panel-${i}"><h3 class="mc-panel-title">Synthetic panel ${i}</h3>` +
    `<p class="mc-panel-body">Padding block ${i} of a mock sign-in page. A real portal ships roughly this ` +
    `much boilerplate (menus, footers, accessibility text, marketing) around the sign-in form.</p></div>`,
).join("\n");

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The sign-in page an unauthenticated request lands on. Contains a
 * __RequestVerificationToken hidden input (the trap) AND an actual sign-in
 * form, which is what distinguishes it from a real app page.
 */
export function loginPage(postLoginUrl: string): string {
  return `<!doctype html><html><head><title>MyChart - Sign In</title></head><body>
<form id="loginForm" method="post" action="Authentication/Login">
<input name="__RequestVerificationToken" type="hidden" value="${LOGIN_PAGE_TOKEN}" />
<input type="hidden" name="postloginurl" value="${attr(postLoginUrl)}" />
<label for="Login">MyChart username</label>
<input id="Login" name="Login" type="text" autocomplete="username" />
<label for="Password">Password</label>
<input id="Password" name="Password" type="password" autocomplete="current-password" />
<button type="submit">Sign in</button>
</form>
${LOGIN_FILLER}
</body></html>`;
}

/**
 * An edge/WAF interstitial: HTML where JSON was expected, but NOT a login page
 * (no sign-in form, no login URL). "Redirected to login" and "a robot check ate
 * the API" are different failures and need different advice.
 */
export const WAF_CHALLENGE_PAGE = `<!doctype html><html><head><title>Checking your browser</title></head><body>
<div id="challenge-running">One more step - we are verifying your request before it continues.</div>
<noscript>Please enable JavaScript and refresh.</noscript>
</body></html>`;

/** Which instance-flavored markup to graft onto every served app page. */
export interface PageChrome {
  /** "PX" build: the live token is embedded in the page, plus PX globals. */
  px?: boolean;
  /** Put a STALE token in the markup BEFORE the live one. */
  staleToken?: boolean;
  /** Point asset/nav links at this prefix (e.g. a live alias of the real one). */
  linkPrefix?: string;
}

/** Markup injected before </body> of every app page to imitate a variant. */
export function pageChrome(v: PageChrome): string {
  const parts: string[] = [];
  if (v.linkPrefix !== undefined) {
    parts.push(
      `<link rel="stylesheet" href="${v.linkPrefix}/styles/mychart.css" />` +
        `<script src="${v.linkPrefix}/scripts/app.js"></script>` +
        `<a href="${v.linkPrefix}/Home">Home</a>`,
    );
  }
  // Document order matters: the stale one must come first so a naive
  // querySelector('input[name="__RequestVerificationToken"]') finds it.
  if (v.staleToken) {
    parts.push(
      `<form id="signOutForm" method="post" action="Home/LogOut">` +
        `<input name="__RequestVerificationToken" type="hidden" value="${STALE_PAGE_TOKEN}" /></form>`,
    );
  }
  if (v.px) {
    parts.push(
      `<input name="__RequestVerificationToken" type="hidden" value="${CSRF_TOKEN}" />` +
        `<script>self.EpicPx={build:"px",version:"mock"};` +
        `self.webpackChunk_epic_px_sdk=self.webpackChunk_epic_px_sdk||[];</script>`,
    );
  }
  return parts.join("");
}

// ---------------------------------------------------------------- structured
export const healthSummary = {
  patientFirstName: "Alex",
  header: {
    patientAge: " 34 yr ",
    height: { value: "170 cm (5' 7\")", dateRecorded: "2026-01-05" },
    weight: { value: "70 kg (154 lb)", dateRecorded: "2026-01-05" },
    bloodType: "O+",
  },
};

export const contactInformation = {
  currentValues: {
    address: { formattedValues: ["123 Example St", "Sampletown, IA 50000"] },
    email: { value: "alex@example.test" },
    mobilePhone: { formattedValue: "555-0100" },
    homePhone: { value: "" },
  },
};

export const allergies = {
  dateOfBirth: "2/2/1992",
  dataList: [
    {
      allergyItem: {
        name: "Penicillin",
        isSevere: true,
        formattedDateNoted: "3/1/2015",
        reactionList: [{ title: "Hives" }, { title: "Swelling, facial" }],
      },
    },
    {
      allergyItem: {
        name: "Peanut",
        isSevere: false,
        formattedDateNoted: "5/5/2010",
        reactionList: [],
      },
    },
  ],
};

export const healthIssues = {
  dataList: [
    { healthIssueItem: { name: "Seasonal allergic rhinitis", formattedDateNoted: "4/1/2018" } },
    { healthIssueItem: { name: "Hypertension", formattedDateNoted: "8/10/2022" } },
  ],
};

export const immunizations = {
  organizationImmunizationList: [
    {
      orgImmunizations: [
        { name: "Influenza", formattedAdministeredDates: ["10/1/2024", "10/1/2025"] },
        { name: "COVID-19", formattedAdministeredDates: ["9/15/2023"] },
      ],
    },
  ],
};

export const medications = {
  sections: [
    {
      prescriptions: [
        {
          name: "Lisinopril 10 mg tablet",
          sig: "Take 1 tablet by mouth daily",
          dateToDisplay: "1/2/2026",
          authorizingProvider: { name: "Dr. Casey Demo" },
        },
      ],
    },
    {
      prescriptions: [
        {
          name: "Cetirizine 10 mg tablet",
          sig: "Take 1 tablet daily as needed",
          dateToDisplay: "6/1/2025",
          authorizingProvider: "Dr. Robin Sample",
        },
      ],
    },
  ],
};

export const histories = {
  medical: [{ name: "Appendectomy", year: "2005" }],
  social: { smokingStatus: "Never smoker" },
  family: [{ relation: "Mother", condition: "Hypertension" }],
};

// ---------------------------------------------------------------- results
export const testResultsList = {
  // Real MyChart exposes the per-order key (eorderid) as newResultGroups[].key;
  // the eorderid is derivable from this payload without the SPA page.
  newResultGroups: [
    { key: "EO1", name: "CBC With Differential", formattedDate: "May 1, 2026" },
    { key: "EO2", name: "MRI Brain w/o contrast", formattedDate: "Apr 15, 2026" },
  ],
  results: [
    { key: "K1", name: "CBC With Differential" },
    { key: "K2", name: "MRI Brain w/o contrast" },
  ],
};

export const testResultDetails: Record<string, unknown> = {
  EO1: {
    orderName: "CBC",
    results: [
      {
        name: "CBC With Differential",
        orderMetadata: {
          prioritizedInstantDisplay: "5/1/2026 8:00 AM",
          orderProviderName: "Dr. Casey Demo",
        },
        resultComponents: [
          {
            componentInfo: { name: "WBC", units: "K/uL" },
            componentResultInfo: {
              value: "12.1",
              abnormalFlagCategoryValue: "High",
              referenceRange: { formattedReferenceRange: "4.0 - 11.0" },
            },
          },
          {
            componentInfo: { name: "HGB", units: "g/dL" },
            componentResultInfo: {
              value: "14.0",
              abnormalFlagCategoryValue: "Unknown",
              referenceRange: { formattedReferenceRange: "13.5 - 17.5" },
            },
          },
        ],
      },
    ],
  },
  EO2: {
    orderName: "MRI Brain",
    results: [
      {
        name: "MRI Brain w/o contrast",
        orderMetadata: {
          resultTimestampDisplay: "4/15/2026 2:30 PM",
          orderProviderName: "Dr. Robin Sample",
        },
        resultComponents: [],
        studyResult: {
          narrative: { contentAsString: "No acute intracranial abnormality. " },
          impression: { contentAsString: "Normal study." },
        },
      },
    ],
  },
};

export const testResultsAppPage = `<!doctype html><html><head><title>Test Results</title></head><body>
<div id="mock-section">test-results</div>
<a class="ResultDetailsLink" href="test-results/details?eorderid=EO1">CBC With Differential</a>
<a class="ResultDetailsLink" href="test-results/details?eorderid=EO2&amp;source=1">MRI Brain</a>
<a class="ResultDetailsLink" href="test-results/details?eorderid=EO1">CBC (duplicate link)</a>
</body></html>`;

// ---------------------------------------------------------------- visits
export const loadUpcoming = {
  Appointments: [
    {
      // future appointment: no Csn yet (keeps encounter count = past visits)
      PrimaryDate: "9/1/2026",
      VisitTypeName: "Annual physical",
      PrimaryProviderName: "Dr. Casey Demo",
      PrimaryDepartment: { Name: "Family Medicine" },
    },
  ],
};

export const loadPastPages: Record<string, unknown> = {
  // serializedIndex "" → first page (HasMoreData true)
  "": {
    SerializedIndex: "IDX2",
    Organizations: [
      {
        HasMoreData: true,
        Visits: [
          {
            Csn: "CSN1",
            PrimaryDate: "3/1/2026",
            VisitTypeName: "Office Visit",
            PrimaryProviderName: "Dr. Casey Demo",
            PrimaryDepartment: { Name: "Family Medicine" },
            IsClinicalNoteAvailable: true,
            IsVisitSummaryEnabled: true,
          },
          {
            Csn: "CSN2",
            PrimaryDate: "11/10/2025",
            VisitTypeName: "Telehealth",
            PrimaryProviderName: "Dr. Robin Sample",
            PrimaryDepartment: { Name: "Internal Medicine" },
            IsClinicalNoteAvailable: false,
            IsVisitSummaryEnabled: true,
          },
        ],
      },
    ],
  },
  // serializedIndex "IDX2" → last page (HasMoreData false)
  IDX2: {
    SerializedIndex: "IDX3",
    Organizations: [
      {
        HasMoreData: false,
        Visits: [
          {
            Csn: "CSN3",
            PrimaryDate: "7/20/2024",
            VisitTypeName: "Urgent Care",
            PrimaryProviderName: "Dr. Jamie Placeholder",
            PrimaryDepartment: { Name: "Urgent Care" },
            IsClinicalNoteAvailable: true,
            IsVisitSummaryEnabled: false,
          },
        ],
      },
    ],
  },
};

export function avsFor(csn: string): unknown {
  return {
    reportContent: `<div class="avs">After Visit Summary for ${csn} — Alex Example (synthetic)</div>`,
    reportCss: ".avs{font-family:sans-serif}",
  };
}

export function openNotesFor(csn: string): unknown {
  return {
    reportContent: `<div class="note">Progress note content for ${csn} (synthetic)</div>`,
    reportCss: "",
  };
}

export const visitNotes: Record<string, unknown> = {
  CSN1: {
    lrpID: "LRP1",
    noteList: [
      {
        hnoID: "H1",
        hnoDAT: "D1",
        displayName: "Progress Note",
        provider: "Dr. Casey Demo",
        iso: "2026-03-01T10:00:00",
      },
    ],
  },
  CSN2: { lrpID: "", noteList: [] },
  CSN3: { lrpID: "", noteList: [] },
};

// ---------------------------------------------------------------- messages
export const foldersList = { folders: [{ name: "Inbox" }, { name: "Sent" }] };
export const organizationsList = { organizations: [{ id: "ORG1", name: "Example Health" }] };

export function conversationList(tag: number): unknown {
  if (tag === 1) {
    return {
      conversations: [
        { hthId: "TH1", subject: "Lab results question", organizationId: "ORG1" },
      ],
    };
  }
  if (tag === 2) {
    return {
      conversations: [
        { hthId: "TH2", subject: "Refill request" },
        // duplicate of TH1: exercises first-tag-wins dedupe
        { hthId: "TH1", subject: "Lab results question", organizationId: "ORG1" },
      ],
    };
  }
  return { conversations: [] };
}

export const conversationDetails: Record<string, unknown> = {
  TH1: {
    messages: [
      {
        body: "<p>Hello Alex, your lab results look fine overall.</p>",
        deliveryInstantISO: "2026-05-02T09:00:00",
        author: { name: "Dr. Casey Demo" },
      },
      {
        body: "<p>Thank you!</p>",
        deliveryInstantISO: "2026-05-02T10:00:00",
        author: { name: "Alex Example" },
      },
    ],
  },
  TH2: {
    messageList: [
      {
        body: "<p>Your refill was sent to Example Pharmacy.</p>",
        date: "4/1/2026",
        author: { name: "Nurse Demo" },
      },
    ],
  },
};

// ---------------------------------------------------------------- flowsheets
export const flowsheetsList = { flowsheets: [{ episodeId: "FL1", name: "Blood Pressure" }] };

export function flowsheetReadings(endInstantIso: string): unknown {
  if (endInstantIso === "") {
    return {
      readings: [
        { takenInstant: "2026-06-01T08:00:00", value: "120/80" },
        { takenInstant: "2026-06-02T08:00:00", value: "118/79" },
      ],
    };
  }
  // second page repeats the oldest ISO only → phase stops (no new ISOs)
  return { readings: [{ takenInstant: "2026-06-01T08:00:00", value: "120/80" }] };
}

// ---------------------------------------------------------------- ccda
export const releaseRecords = {
  records: [
    {
      releaseId: "REL1",
      documentId: "DOC1",
      isDownloadable: "1",
      type: "VDT",
      packageName: "AlexExample_records.zip",
    },
  ],
};

const XML_DOC = (n: number) =>
  `<?xml version="1.0"?><ClinicalDocument><title>Synthetic C-CDA ${n} — Alex Example</title></ClinicalDocument>`;

export function buildCcdaZip(): Uint8Array {
  const enc = new TextEncoder();
  return zipSync({
    "IHE_XDM/SUBSET01/DOC0001.XML": enc.encode(XML_DOC(1)),
    "IHE_XDM/SUBSET01/DOC0002.XML": enc.encode(XML_DOC(2)),
    "INDEX.HTM": enc.encode("<html><body>Index</body></html>"),
  });
}

// ---------------------------------------------------------------- misc simple
/**
 * Other-documents with CONTENT, sized to exercise the census/selection flow:
 * two ordinary files and one deliberate size outlier (mirrors the field case
 * where a single uncompressed insurance-card scan dwarfed the whole export).
 */
export const OTHER_DOCUMENTS = [
  { dcsID: "DOC-A", docExt: "PDF", docDesc: "After Visit Summary Letter", docType: "Letter", date: "3/2/2026" },
  { dcsID: "DOC-B", docExt: "TIF", docDesc: "Insurance Card", docType: "Insurance Card", date: "1/5/2026" },
  { dcsID: "DOC-C", docExt: "TIF", docDesc: "ID Card Scan (high resolution)", docType: "Insurance Card", date: "10/1/2025" },
];

const DOC_SIZES: Record<string, number> = { "DOC-A": 2_000, "DOC-B": 40_000, "DOC-C": 3_000_000 };

export function docToken(dcsId: string): string {
  return `doc-token-${dcsId}`;
}

/** Deterministic filler bytes for a document (no randomness — resumable CI). */
export function docBytes(dcsId: string): Uint8Array | null {
  const n = DOC_SIZES[dcsId];
  if (!n) return null;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + dcsId.charCodeAt(dcsId.length - 1)) % 251;
  return b;
}

export const simpleJson: Record<string, unknown> = {
  "api/health-summary/FetchHealthSummary": healthSummary,
  "api/health-summary/FetchH2GHeader": { header: null },
  "api/allergies/LoadAllergies": allergies,
  "api/immunizations/LoadImmunizations": immunizations,
  "api/HealthIssues/LoadHealthIssuesData": healthIssues,
  "api/medications/LoadMedicationsPage": medications,
  "api/histories/LoadHistoriesViewModel": histories,
  "api/goals/LoadPatientGoals": { goals: [] },
  "api/goals/LoadCareTeamGoals": { goals: [] },
  "api/upcoming-orders/GetUpcomingOrders": { orders: [] },
  "api/personalInformation/GetContactInformation": contactInformation,
  "api/personalInformation/GetDetailsAboutMeInformation": { preferredName: "Alex" },
  "api/personalInformation/GetRelationships": { relationships: [] },
  "api/personalInformation/GetContextIds": { contexts: [{ id: "CTX1", name: "Alex Example" }] },
  "api/track-my-health/GetFlowsheets": flowsheetsList,
  "api/track-my-health/GetExternalAccounts": { accounts: [] },
  "api/letters/GetLettersList": { letters: [] },
  "api/item-feed/FetchItemFeed": { items: [] },
  "api/documents/viewer/LoadOtherDocuments": { documents: OTHER_DOCUMENTS },
};

/** CLASSIC endpoints (form/nobody POSTs), keyed by pathname under the prefix. */
export const classicJson: Record<string, unknown> = {
  "Clinical/Medications/LoadExternal": { externalMedications: [] },
  "Clinical/CareTeam/Load": { careTeam: [{ name: "Dr. Casey Demo", role: "Primary Care Provider" }] },
  "Clinical/CareTeam/LoadExternal": { providers: [] },
  "Clinical/CovidStatus/LoadCovidStatus": { status: "No results on file" },
  "HealthAdvisories/GetTopics": { topics: [{ name: "Influenza vaccine", status: "Due" }] },
  "Insurance/Coverages/GetCoverages": { coverages: [{ payor: "Example Health Plan" }] },
  "Insurance/Coverages/GetPayors": { payors: [] },
  "Demographics/Relationships/GetRelationshipList": { relationships: [] },
  "Questionnaire/MyChartQuestionnaire/GetQuestionnaireList": { questionnaires: [] },
};

export function sectionPage(name: string): string {
  return `<!doctype html><html><head><title>${name}</title></head><body><div id="mock-section">${name}</div><p>Synthetic MyChart section page.</p></body></html>`;
}
