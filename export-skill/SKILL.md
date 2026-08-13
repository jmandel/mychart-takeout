# Working with this MyChart export

You are looking at a **complete export of one person's Epic MyChart record**,
produced by [mychart-takeout](https://github.com/jmandel/mychart-takeout). It
is **deterministic and faithful** — every file was pulled straight from the
patient portal's own API and documents; nothing was summarized or altered by a
model at export time. Your job is to help the record's owner read, understand,
and use it. This guide orients you.

## This is the owner's PHI

Treat everything here as sensitive personal health information. Analyze it
locally for the person who exported it. **Do not upload, post, or send it
anywhere** unless they explicitly ask you to and name the destination.

## Where to start

1. **`PATIENT_SUMMARY.md`** — a human-readable overview (demographics, problems,
   allergies, meds, results tables, encounters, messages). Good for a fast read.
2. **`indexes/*.csv`** — flat spreadsheets (problems, allergies, immunizations,
   medications, test_results, test_result_components, encounters, messages) for
   filtering/sorting/plotting.
3. **`structured/`** — the **source of truth**: raw JSON per domain, exactly as
   the portal returned it. When accuracy matters, read here, not the summary.

`PATIENT_SUMMARY.md` and the CSVs are *derived* from `structured/` and are
lossy (they surface common fields). For any clinical detail, dates, values,
reference ranges, or narratives, **verify against the JSON in `structured/`**
and cite the file path.

## Layout

```
PATIENT_SUMMARY.md / .json    consolidated overview (derived)
indexes/*.csv                 flat tables (derived)
MANIFEST.json                 file + record counts for this export
GAPS.md / gaps.json           what was and WASN'T captured (read this — see below)
_manifest.json                per-endpoint outcome log
structured/                   SOURCE OF TRUTH — raw JSON per domain, e.g.:
  health-summary/ allergies/ immunizations/ health-issues/ medications/
  medications-ext/ histories/ goals/ personal-info/ insurance/ care-team/
  covid/ preventive-care/ questionnaires/ relationships/ letters/ item-feed/
  documents/ upcoming-orders/ referrals/ education/ growth-charts/
  track-my-health/            patient-tracked vitals (flowsheet readings)
  test-results/
    GetList.json              all result orders
    details/NN_<name>.json    per-order component values, units, reference
                              ranges, abnormal flags, radiology/path narratives
  visits/
    past_page_*.json, upcoming.json, _visit_index.json
    avs/NN.html               After-Visit Summaries (rendered HTML)
    notes/NN_*.html           clinical notes (rendered HTML)
  messages/
    list_tag*.json, _threads_full_index.json
    threads_full/NNN_*.json   per-thread JSON
    threads_full/NNN_*_mN.html  each message body (rendered HTML)
  _captured_from_navigation/  (CDP exports only) best JSON per endpoint
documents/ccda/               (if --ccda) standards C-CDA all-visits package
  HealthSummary_all_visits_CCDA.zip + extracted/  one ClinicalDocument per visit
dom/                          per-section page HTML/text snapshots (if enabled)
raw_network/                  (CDP exports only) raw response log + bodies
```

Not every folder exists in every export — presence depends on the person's data
and how the export was run (browser exports omit `raw_network/`,
`_captured_from_navigation/`, and screenshots).

## Read `GAPS.md` before concluding "there is no X"

Each run classifies every endpoint call. `GAPS.md` lists anything that failed
or was unavailable on this person's instance. If a data type looks missing,
check `GAPS.md` first — the portal may not offer that feature here, which is
different from "the person has none." Absence in the export ≠ absence in care.

## Provenance: this record may combine multiple health systems

Epic portals often **aggregate records from other organizations** the person has
visited (Epic calls this Happy Together / Care Everywhere). So a single export
can contain data that originated at a *different* health system. Where the
portal tags it, items carry:

- **`organizationName`** — the source organization.
- **`isExternal`** — `true` for records pulled from another organization.

Guidance:
- When it matters (e.g., "who prescribed this?", "where was this test done?"),
  **check `organizationName` / `isExternal`** rather than assuming one provider.
- **External/aggregated data is often a summarized view** and can be lower
  fidelity or less complete than the originating system's own record.
- **Messages are tagged by the delivering portal, not the clinical source** —
  their `organizationName` is unreliable for provenance; read the body.

## Data encoding notes

- **IDs are opaque** (e.g. long `WP-…`-style tokens). Use them for joins within
  this export; they are not human meaningful and are instance-specific.
- **Dates are usually pre-formatted display strings** ("Jul 02, 2024",
  "5/1/2026 8:00 AM"), not ISO — parse loosely and preserve the original text.
- **AVS, notes, and message bodies are rendered HTML** with inline styles;
  extract text for reading, keep the HTML for fidelity.
- **Abnormal lab values** carry a `flag` (e.g. "High"/"Low") in
  `test-results/details/*.json` and `indexes/test_result_components.csv` — a
  reliable signal when scanning results.

## What is NOT here

- **FHIR / bulk API** data (needs a separate OAuth client) and, on most
  instances, the **EHI computer-readable export** — neither is included.
- **Detailed billing/financial** data — the portal serves it as web pages, not
  an API, so only the `dom/` snapshot (if present) reflects it.
- **Imaging pixels** (DICOM) — radiology *reports/narratives* are included, not
  the images themselves.

## Being genuinely useful

Good tasks to offer: build a medical timeline; list active problems and meds
with reconciliation; surface abnormal results over time; summarize recent
visits from their AVS/notes; extract immunization or allergy lists; draft a
one-page portable summary. Always **ground claims in `structured/` and cite the
file**, flag provenance when combining sources, and say when something is
uncertain or missing rather than inferring.
