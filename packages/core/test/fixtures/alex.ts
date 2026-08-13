/** Synthetic fixture patient "Alex Example" — strictly non-PHI invented data. */

export const ALEX_ALLERGIES = {
  dateOfBirth: "1/1/1980",
  dataList: [
    {
      allergyItem: {
        name: "Penicillin",
        isSevere: true,
        formattedDateNoted: "1/2/2020",
        reactionList: [{ title: "Hives" }],
      },
    },
  ],
};

export const ALEX_HEALTH_SUMMARY = {
  patientFirstName: "Alex",
  header: { patientAge: " 45 ", height: { value: `5' 10"` }, weight: { value: "170 lb" } },
};

export const ALEX_UPCOMING = {
  Appointments: [{ Csn: "CSN-UP" }],
};

export const ALEX_PAST_PAGE_1 = {
  SerializedIndex: "IDX2",
  Groups: [
    {
      HasMoreData: true,
      Visits: [
        {
          Csn: "CSN-1",
          PrimaryDate: "7/1/2025",
          VisitTypeName: "Office Visit",
          PrimaryProviderName: "Dr. Fake Person",
          PrimaryDepartment: { Name: "Example Clinic A" },
          IsClinicalNoteAvailable: true,
          IsVisitSummaryEnabled: true,
        },
      ],
    },
  ],
};

export const ALEX_PAST_PAGE_2 = {
  SerializedIndex: "IDX3",
  Groups: [
    {
      HasMoreData: false,
      Visits: [
        {
          Csn: "CSN-2",
          PrimaryDate: "6/1/2025",
          VisitTypeName: "Telehealth",
          PrimaryProviderName: "Dr. Other Person",
          PrimaryDepartment: "Example Clinic B",
        },
      ],
    },
  ],
};

export const ALEX_CONV_TAG1 = {
  conversations: [
    { hthId: "T1", subject: "Lab follow-up", organizationId: null },
    { hthId: "T2", subject: null },
  ],
};

export const ALEX_THREAD_T1 = {
  messages: [
    {
      body: "<p>Hello Alex, your results look fine.</p>",
      deliveryInstantISO: "2025-07-02T10:00:00",
      author: { name: "Dr. Fake Person" },
    },
    { body: "" },
  ],
};

export const ALEX_FLOWSHEETS = {
  flowsheets: [{ episodeId: "EP1", name: "Blood Pressure" }],
};

export const ALEX_READINGS_P0 = {
  readings: [
    { takenInstant: "2025-07-01T08:00", value: "120/80" },
    { takenInstant: "2025-06-01T08:00", value: "118/78" },
  ],
};

export const ALEX_READINGS_P1 = {
  readings: [{ takenInstant: "2025-06-01T08:00", value: "118/78" }],
};

export const ALEX_RELEASE_RECORDS_READY = {
  data: {
    releases: [
      {
        releaseId: "R1",
        documentId: "D1",
        isDownloadable: 1,
        type: "VDT",
        packageName: "AlexExample.zip",
      },
      { releaseId: "R2", documentId: "D2", isDownloadable: "0", type: "VDT" },
    ],
  },
};
