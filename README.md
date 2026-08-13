# MyChart Personal Health Record Exporter

Export **all of your own health data** from an authenticated Epic **MyChart**
patient portal session. Built and verified against several production Epic
instances; designed to generalize to any MyChart site.

The exporter is **deterministic** — no language model is involved in the export
itself. Every endpoint, parameter, and file name is fixed in code or derived
mechanically from API responses. An agent (or a human) can *drive* it, extend
it, and diagnose gaps, but the data path is plain code.

## How it works

MyChart's web app is a thin SPA over an internal JSON API:
`POST /MyChart/api/<area>/<Method>` with a CSRF header
(`__RequestVerificationToken`, fetched from `/MyChart/Home/CSRFToken`).
This tool replays those same calls **from inside an authenticated browser
page**, so real cookies, headers, and the WAF's browser fingerprint all come
for free. It never sees or stores your password.

Two ways to reach that authenticated page:

1. **CDP mode (primary today).** You launch your own Chromium with
   `--remote-debugging-port=9222`, sign in to MyChart, and the exporter
   attaches over the Chrome DevTools Protocol. It evaluates `fetch()` calls
   in-page, logs all network traffic, snapshots DOM, and writes the export
   tree to disk. This mode is also what agents use: the same session offers
   small probe verbs (`goto`, `eval`, `api`, `snapshot`) for live discovery,
   self-healing when an instance renames an endpoint, and noticing missing
   data.
2. **In-browser mode (console paste / bookmarklet).** The same core logic
   compiled to a single self-contained script you paste into the DevTools
   console (or click as a bookmarklet) on an open MyChart tab. It collects
   the same data with in-page `fetch()` (section pages load in hidden
   same-origin iframes) and hands you the export as a downloadable ZIP. No
   install, works on machines where you can't launch a debug browser. Loses
   only the forensic layer (screenshots, passive network capture).

Both modes share one TypeScript codebase (`packages/core` is isomorphic —
it runs in a Bun process *or* in the page, with transport and output sinks
injected; see `PLAN.md`). The original Python implementation was deleted at
P5 parity sign-off (2026-08-13) — git history is the archive.

## Use it

```bash
bun install                                  # once

# CDP mode:
./launch_browser.sh                          # Chromium with CDP on :9222
#   → sign in to MyChart in that window
bun apps/cli/src/main.ts export --ccda       # writes ./export/
bun apps/cli/src/main.ts whereami            # probe verbs: targets, goto,
                                             #   eval, api, snapshot, report

# In-browser mode:
bun run build:web                            # emits apps/web-build/dist/
# paste dist/console.js into DevTools on a signed-in MyChart tab,
# or install dist/bookmarklet.txt as a bookmark; click Start → download ZIP
```

Re-run any time you're signed in; it always pulls fresh data. Output lands
in the `--out` dir — start with its `PATIENT_SUMMARY.md` and `README.md`.

`export` flags: `--out DIR` · `--ccda` (standards C-CDA) · `--screenshots`
(PNGs, off by default) · `--no-dom` (skip page HTML/text snapshots) ·
`--no-raw` (don't keep raw bodies) · `--only PHASE` (one of: structured,
test-results, visits, messages, flowsheets, ccda, dom, salvage, report).

## What it captures

- **Structured JSON** (source of truth): problems, allergies, medications
  (incl. external), immunizations, medical/surgical/family/social history,
  goals, care team, preventive care, insurance/coverage, demographics &
  contact info, letters, questionnaires, upcoming orders, item feed, COVID
  status, patient-tracked flowsheets (all readings, paginated).
- **Test & imaging results**: full list plus per-order details — component
  values, units, reference ranges, abnormal flags, radiology/pathology
  narratives.
- **Visits/encounters**: upcoming + complete past history (paginated), and
  per-encounter **After-Visit Summary** and **clinical notes** as rendered
  HTML.
- **Messages**: every conversation thread with full per-message HTML bodies.
- **Standards C-CDA** (`--ccda`): the official "All visit records" IHE-XDM
  ZIP (one C-CDA `ClinicalDocument` per visit + health summary), requested,
  polled, downloaded, and extracted automatically.
- **Report layer** (derived, offline): `PATIENT_SUMMARY.md`/`.json`,
  flat CSV indexes (`indexes/*.csv`), `MANIFEST.json`, and a README inside
  the export explaining provenance.
- **Forensics** (CDP mode): raw network log + response bodies, per-section
  DOM HTML/text, optional full-page screenshots.

### Output layout (`export/`)

```
PATIENT_SUMMARY.md / .json   consolidated summary
indexes/*.csv                flat spreadsheets
MANIFEST.json                file + record counts
structured/                  structured JSON per domain (source of truth)
  test-results/details/        per-order values, ranges, narratives
  visits/avs|notes/            After-Visit Summaries + clinical notes (HTML)
  messages/threads_full/       per-thread JSON + per-message HTML bodies
  _captured_from_navigation/   best JSON body per endpoint (provenance)
dom/                         per-page rendered HTML + text (if enabled)
screenshots/                 full-page PNGs (only if --screenshots)
raw_network/                 raw response log + bodies (only if raw capture on)
documents/ccda/              standards C-CDA export (only if --ccda)
```

## Repository layout

```
packages/core/         isomorphic exporter core: contracts, endpoint catalog,
                       phases, report builder (no fs/DOM/Bun imports — enforced)
packages/cdp/          Bun-side driver: CDP session, in-page fetch bridge,
                       network logger, salvage, fs sink
packages/browser/      in-page driver: page-fetch client, zip sink, iframe
                       section loader, progress overlay
apps/cli/              bun CLI: export/report + probe verbs (agent surface)
apps/web-build/        builds dist/console.js + dist/bookmarklet.txt
tools/mock-mychart/    synthetic-patient mock instance (CI target, no PHI)
tools/parity.ts        export tree diff (paths/keys/counts only — no values)
launch_browser.sh      start Chromium into the MyChart profile with CDP
PLAN.md                phased plan + per-phase tests (P0–P5 done)
export*/               output — PHI, git-ignored, stays local
```

## Development & testing

```bash
bun test          # 110 tests: unit + golden + an end-to-end run in real
                  # headless Chromium against tools/mock-mychart (no PHI)
bunx tsc --noEmit # strict typecheck
bun run build:web # bundle size-budgeted console/bookmarklet artifacts
```

Parity provenance (P5, 2026-08-13): the TS exporter and the original
Python ran back-to-back against the same live session; `tools/parity.ts`
showed zero structured-JSON key diffs and identical record counts
(25 encounters / 25 notes, 67 threads / 97 messages, 12 result orders),
with runtimes within 4% (106s vs 110s). The report builder's golden tests
had earlier been frozen by byte-comparing against the Python on identical
fixture trees. The Python was then deleted (git history keeps it).
`tools/parity.ts` remains useful for comparing any two export runs.

## Known limitations & instance notes

- **FHIR R4** needs a registered OAuth2 `client_id`; MyChart session cookies
  don't authenticate it. The internal API yields the same clinical facts and
  the C-CDA is the standards-format export.
- **EHI computer-readable export** is disabled on some instances (redirects to
  Home). On instances that enable it, it is the deepest export
  tier and worth adding as a phase.
- Endpoint paths/payloads were discovered on one instance running one Epic
  version. Other instances vary in path prefix (`/MyChart`, `/MyChart-PRD`,
  …), enabled features, and payload shapes; the plan's robustness phase
  covers deriving the base from the page, classifying per-endpoint outcomes,
  and emitting a **gaps report** instead of failing.

## PHI safety

Exports contain PHI. They are written only to the local `export*/`
directories, which are **git-ignored**; nothing under them is ever committed
or published. The code contains no credentials — authentication is always
your own live browser session.
