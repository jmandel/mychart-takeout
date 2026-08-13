/**
 * Endpoint catalog, transcribed from the CURRENT export.py (endpoint tables
 * "discovered once, now constant"). All paths are PREFIX-RELATIVE — the Mc
 * wrapper joins them to client.prefix (e.g. "/MyChart") — so instances with a
 * different first path part need no table edits.
 *
 * Body sentinels (resolved by the structured phase):
 *   "NONCE"    → { PageNonce: ctx.nonce }
 *   "UPCOMING" → { selectedOrderID: "", PageNonce: ctx.nonce }
 *   "ITEMFEED" → { timeZone: ctx.timeZone, feedHost: 1, conditionViewHfrID: "" }
 */

export type SimpleBody = Record<string, unknown> | "NONCE" | "UPCOMING" | "ITEMFEED";

export interface SimpleEntry {
  domain: string;
  path: string;
  body: SimpleBody;
}

export const SIMPLE: SimpleEntry[] = [
  { domain: "health-summary", path: "api/health-summary/FetchHealthSummary", body: {} },
  { domain: "health-summary", path: "api/health-summary/FetchH2GHeader", body: {} },
  { domain: "allergies", path: "api/allergies/LoadAllergies", body: { isHealthSummary: false } },
  { domain: "immunizations", path: "api/immunizations/LoadImmunizations", body: {} },
  { domain: "health-issues", path: "api/HealthIssues/LoadHealthIssuesData", body: { isHealthSummary: false } },
  { domain: "medications", path: "api/medications/LoadMedicationsPage", body: { context: 2 } },
  { domain: "histories", path: "api/histories/LoadHistoriesViewModel", body: {} },
  { domain: "goals", path: "api/goals/LoadPatientGoals", body: "NONCE" },
  { domain: "goals", path: "api/goals/LoadCareTeamGoals", body: "NONCE" },
  { domain: "upcoming-orders", path: "api/upcoming-orders/GetUpcomingOrders", body: "UPCOMING" },
  { domain: "personal-info", path: "api/personalInformation/GetContactInformation", body: {} },
  { domain: "personal-info", path: "api/personalInformation/GetDetailsAboutMeInformation", body: {} },
  { domain: "personal-info", path: "api/personalInformation/GetRelationships", body: {} },
  { domain: "personal-info", path: "api/personalInformation/GetContextIds", body: {} },
  { domain: "track-my-health", path: "api/track-my-health/GetFlowsheets", body: {} },
  { domain: "track-my-health", path: "api/track-my-health/GetExternalAccounts", body: {} },
  { domain: "letters", path: "api/letters/GetLettersList", body: {} },
  { domain: "item-feed", path: "api/item-feed/FetchItemFeed", body: "ITEMFEED" },
  { domain: "documents", path: "api/documents/viewer/LoadOtherDocuments", body: {} },
  // Discovered via CDP passive capture on other instances (not in the original instance's
  // menu, but standard Epic activities); absent sites degrade to a gaps row.
  { domain: "referrals", path: "api/referrals/listReferrals", body: {} },
  { domain: "education", path: "api/education/GetPatEducationTitles", body: {} },
  // Pediatric growth charts (measurement series + percentiles); confirmed live
  // for a proxy child. Empty for patients without growth data.
  { domain: "growth-charts", path: "api/growth-charts/GetGrowthCharts", body: {} },
  // Implanted/explanted devices (pacemakers, ICDs, leads, IOLs, ortho hardware)
  // with manufacturer/model/serial/UDI + implant procedure. Often the single
  // most consequential structured fact and absent from a C-CDA. (Endpoint
  // learned from Hugo Campos's OpenKP.)
  { domain: "implants", path: "api/implants/GetImplants", body: {} },
  // Care to-dos / tasks and reminders.
  { domain: "todo", path: "api/todo/GetTasks", body: {} },
  { domain: "todo", path: "api/todo/GetPersistentTasks", body: {} },
  // Linked / community organizations your record connects to (Happy Together).
  { domain: "linked-orgs", path: "Community/External/GetMyChartInactiveOrgs", body: {} },
  // Record sharing: hub activities + Care/Share Everywhere security posture.
  { domain: "sharing", path: "api/sharing-hub/GetSelfServiceActivities", body: {} },
  { domain: "sharing", path: "api/sharing-hub/GetSecurity", body: {} },
  // Communication / notification preferences (which channels for which alerts).
  { domain: "communication-prefs", path: "api/communicationPreferences/GetPreferences", body: {} },
  { domain: "communication-prefs", path: "api/communicationPreferences/GetContactInformation", body: {} },
  { domain: "communication-prefs", path: "api/textoptin/GetConsentDataWithTextOptInAccess", body: {} },
  // Account security: 2FA status, password age, remembered-device policy.
  { domain: "security-settings", path: "api/security-settings/GetInitialSettings", body: {} },
  // Trusted / remembered devices signed into this account.
  { domain: "security-settings", path: "Authentication/RememberDevices/GetUserDeviceListInfo", body: {} },
  // Insurance premium-billing accounts (where offered).
  { domain: "premium-billing", path: "api/premium-billing/GetAccounts", body: {} },
];

export type ClassicKind = "form" | "get" | "nobody";

export interface ClassicEntry {
  domain: string;
  path: string;
  form: string;
  kind: ClassicKind;
}

export const CLASSIC: ClassicEntry[] = [
  { domain: "medications-ext", path: "Clinical/Medications/LoadExternal", form: "context=0", kind: "form" },
  // care-team/covid Load endpoints are POST with query params + no body;
  // (a plain GET returns the SPA shell instead of JSON).
  { domain: "care-team", path: "Clinical/CareTeam/Load?hfrId=&sources=&actions=&isPrimaryStandalone=true&ComponentNumber=2", form: "", kind: "nobody" },
  { domain: "care-team", path: "Clinical/CareTeam/LoadExternal?hfrId=&sources=&actions=&ComponentNumber=2", form: "", kind: "nobody" },
  { domain: "covid", path: "Clinical/CovidStatus/LoadCovidStatus", form: "", kind: "nobody" },
  { domain: "preventive-care", path: "HealthAdvisories/GetTopics", form: "registryID=", kind: "form" },
  { domain: "insurance", path: "Insurance/Coverages/GetCoverages", form: "isStandAlone=true&encounterCsn=&encounterDepartmentId=&encounterOrgId=", kind: "form" },
  { domain: "insurance", path: "Insurance/Coverages/GetPayors", form: "encounterCsn=&encounterDepartmentId=", kind: "form" },
  { domain: "relationships", path: "Demographics/Relationships/GetRelationshipList", form: "getEOLDocs=true&disableUTF8=true", kind: "form" },
  { domain: "questionnaires", path: "Questionnaire/MyChartQuestionnaire/GetQuestionnaireList", form: "filterDAT=&filterSeriesByDAT=false&filterCSN=&filterMessage=", kind: "form" },
];

/** Section pages to snapshot (dom phase) — prefix-relative. */
export const SECTIONS: [name: string, path: string][] = [
  ["home", "Home"],
  ["health-summary", "app/health-summary"],
  ["test-results", "Clinical/TestResults"],
  ["medications", "Clinical/Medications"],
  ["medical-history", "MedicalHistory"],
  ["visits", "Visits"],
  ["documents", "Documents"],
  ["messaging", "Messaging"],
  ["preventive-care", "HealthAdvisories"],
  ["upcoming-orders", "app/upcoming-orders"],
  ["track-my-health", "TrackMyHealth"],
  ["care-team", "Clinical/CareTeam"],
  ["letters", "app/letters"],
  ["advance-care", "AdvancedCarePlanning"],
  ["questionnaires", "Questionnaires"],
  ["covid-status", "CovidStatus"],
  ["insurance", "Insurance"],
  ["billing-summary", "Billing/Summary"],
  ["personal-info", "app/personal-information"],
];
