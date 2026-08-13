---
name: mychart-exporter
description: How to run, extend, test, and validate the MyChart personal-health-record exporter — plus the hard-won MyChart/Epic domain knowledge (CSRF, framebusting, provenance tagging, proxy switching, instance variance) needed to work on it safely.
---

# MyChart Exporter — working guide for AIs

This repo exports a patient's **own** data out of an authenticated Epic
**MyChart** portal. It is deterministic (no LLM in the data path) and runs in
two modes from **one** TypeScript codebase. Read this before running or
extending it; it front-loads the non-obvious things that cost real debugging.

## Orientation (read first)

- **What it does:** replays MyChart's internal JSON API (`POST
  <prefix>/api/<area>/<Method>`) from inside an authenticated session, plus
  rendered documents (AVS/notes/messages HTML) and the standards C-CDA. Writes
  a structured export tree + a human `PATIENT_SUMMARY.md` + CSV indexes.
- **Two run modes, shared core:**
  - **CDP** (`apps/cli`): attach over the Chrome DevTools Protocol to a
    browser you already signed in. Agent-friendly (probe verbs, self-heal),
    captures a passive network log, does proxy switching. This is the mode you
    (an AI) drive.
  - **Browser** (`apps/web-build` → `dist/console.js` + bookmarklet): the same
    core compiled to run *inside the page*. The user pastes/clicks it; it
    fetches its own data and downloads a ZIP. No install, no network log.
- **Reference:** the original Python impl was deleted at parity sign-off. Git
  history is the archive. Don't reintroduce it.

## Architecture & the one load-bearing rule

```
packages/core/     ISOMORPHIC — runs in Bun (CDP) AND in the page (browser).
                   MUST NOT import node builtins, playwright, use Bun/process,
                   or touch document/window. Enforced by
                   packages/core/test/isomorphism.test.ts, which greps RAW
                   source text INCLUDING COMMENTS — so never even write
                   "window." or "playwright" in a core comment.
  src/types.ts       MyChartClient / Sink / DomAccess contracts (injected)
  src/mc.ts          CSRF-token cache + mcApi/mcGet/mcForm/mcNobody wrappers
  src/store.ts       ExportStore: writes via Sink + keeps JSON in memory so
                     later phases + the report read back WITHOUT fs (required
                     for browser mode)
  src/catalog.ts     endpoint tables as DATA (SIMPLE/CLASSIC/SECTIONS),
                     PREFIX-RELATIVE ("api/..."), body sentinels
  src/phases/*.ts    structured, testResults, visits, messages, flowsheets,
                     ccda, dom
  src/report/*.ts    PATIENT_SUMMARY / indexes / MANIFEST / README (pure)
  src/gaps.ts        per-call outcome classifier + GAPS.md report
packages/cdp/      Bun-only driver: raw CDP over Bun's native WebSocket,
                   in-page fetch client, network logger, salvage, fs sink,
                   proxy switching
packages/browser/  in-page driver: page-fetch client, zip sink (fflate),
                   fetch+DOMParser DomAccess, progress overlay, bundle entry
apps/cli/          the CLI you drive
apps/web-build/    emits dist/index.html (landing), dist/console.js, dist/bookmarklet.txt
tools/mock-mychart/ synthetic-data MyChart server — the CI target (no PHI)
tools/parity.ts    diff two export trees (paths/keys/counts, never values)
```

Two injected seams make the core reusable: **transport** (`MyChartClient`) and
**output** (`Sink`). CDP injects an evaluate-bridge client + fs sink; browser
injects a `window.fetch` client + zip sink. Phase code never knows which.

## Running it

### Prereq (both modes): an authenticated browser with CDP

```bash
./launch_browser.sh          # Chromium, profile with your MyChart login, CDP :9222
#   → sign in to MyChart in that window
```

### CDP mode (what you drive)

```bash
bun install                                        # once
bun apps/cli/src/main.ts whereami                  # confirm the attached tab
bun apps/cli/src/main.ts export --out export       # full export
# flags:
#   --ccda            also fetch the standards C-CDA all-visits ZIP
#   --screenshots     full-page PNGs (off by default; data is in JSON+dom text)
#   --no-dom          skip per-section HTML/text snapshots
#   --no-raw          don't persist raw response bodies
#   --only PHASE      run one phase (repeatable): structured, test-results,
#                     visits, messages, flowsheets, ccda, dom, salvage, report
#   --host SUBSTR     pick ONE tab when several MyChart portals are open
#                     (e.g. --host clinicname). Matches the tab URL.
#   --proxies         export EVERY accessible subject (you + proxies) into
#                     out/<name>/ — see "Proxy / multi-patient" below
# probe verbs for discovery/debugging: targets, whereami, goto, eval, api, snapshot
bun apps/cli/src/main.ts report --dir export       # rebuild the report offline
```

**Only one driver per tab at a time.** If you run a CDP export while the user
runs the bookmarklet in the same tab (or vice-versa), your navigations destroy
their page context. Use `--host` to stay on a specific portal.

### Browser mode (what the user runs)

```bash
bun run build:web        # emits dist/{index.html, console.js, bookmarklet.txt}
```
- **Easiest install:** open `dist/index.html` (the landing page; also published via GitHub Pages), drag the button to the
  bookmarks bar (dragging preserves the `javascript:` prefix; **pasting a
  bookmarklet URL does not** — browsers strip `javascript:` on paste).
- Then on a signed-in MyChart tab: click it → **Start export** → **Download**.
- Console alternative: DevTools → Console → type `allow pasting` → paste
  `console.js` → `await __mychartExport.run({ ccda: true, dom: false })`.
- The ZIP is named `mychart-export-<host>-<Patient>.zip`.

## Testing & validating (do this after every change)

```bash
bunx tsc --noEmit        # strict typecheck (whole workspace)
bun test                 # unit + golden + TWO real headless-Chromium e2e runs
                         #   (browser bundle + raw-CDP) against tools/mock-mychart
bun run build:web        # size-budgeted bundle build (fails >300KB)
```
- **No test touches PHI** — all fixtures are synthetic ("Alex Example").
- The report golden tests were frozen against the (now-deleted) Python output;
  keep them byte-stable or update deliberately.
- **Live parity / smoke** (needs a signed-in session; results stay local):
  run an export, then `bun tools/parity.ts <dirA> <dirB>` to diff two runs
  (e.g. before/after a change). It prints paths/keys/counts, never values.

## Extending: the discovery loop (how the catalog grows)

The catalog was reverse-engineered from ONE instance, so other instances (and
even the original) expose endpoints we don't capture. To find them:

1. **Passive capture (CDP only).** Navigate the portal broadly; its own SPA
   calls its own APIs; capture them and diff against the catalog. Pattern used
   in this repo's history (see scratch scripts / `raw_network/responses.jsonl`
   + the salvage phase): subscribe to `Network.responseReceived`, navigate the
   activity list, collect `/api|/Clinical|/Billing|...` URLs with a JSON mime,
   subtract the catalog's paths. Browser exports can't do this (no passive log;
   the SPA menu is client-rendered, so a fetched shell shows nothing).
2. **Probe** a candidate: in-page `fetch` with the CSRF header (POST `{}` for
   `api/*`; some are GET). Confirm it returns the patient's data, not config.
3. **Add it** to `catalog.ts` `SIMPLE` (POST JSON) or `CLASSIC`
   (form/get/nobody). Prefix-relative path, `domain` = output folder. The
   structured phase picks it up automatically; absent sites degrade to a gaps
   row. Add/adjust a unit test (the structured test's FakeClient returns
   `{_raw}` for unrouted endpoints, so additions don't break it).

Endpoints added this way so far: `api/referrals/listReferrals`,
`api/education/GetPatEducationTitles`, `api/growth-charts/GetGrowthCharts`.

**Body sentinels** in `SIMPLE` (resolved by the structured phase): `"NONCE"` →
`{PageNonce: nonce}`, `"UPCOMING"` → `{selectedOrderID:"", PageNonce}`,
`"ITEMFEED"` → `{timeZone, feedHost:1, conditionViewHfrID:""}`.

**Gaps report:** every real call is classified (`ok`/`empty`/`spa-shell`/
`redirect-login`/`forbidden`/`not-found`/`server-error`/`http-error`); each run
writes `GAPS.md` + `gaps.json`. When helping a user on a new instance, read
GAPS.md first — a user can share *that* instead of their PHI.

## MyChart / Epic domain knowledge (the non-obvious stuff)

- **CSRF + WAF:** every API call needs header `__RequestVerificationToken`,
  parsed from the hidden input in `GET <prefix>/Home/CSRFToken`. Run `fetch()`
  in-page (both modes do) so requests carry the real browser fingerprint and
  cookies — this sidesteps the F5/Volterra WAF. Never touches credentials.
- **Instance variance is handled by derivation, not config:** origin from the
  page URL; **path prefix** from its first segment (commonly `/MyChart`, but
  some instances use `/MyChart-PRD` or lowercase); timezone from `Intl`. The
  catalog is prefix-relative so none of this needs editing per instance.
  Validated on three live production instances with zero code changes.
- **Test results:** the per-order key (`eorderid`) is
  `GetList → newResultGroups[].key` — derive it from the JSON, NOT by scraping
  the rendered page. (The old page-scrape path is a fallback only; it can't
  work in browser mode — see framebusting.)
- **Framebusting (critical for browser mode):** loading an `app/*` SPA route in
  an iframe boots Epic's client, which detects it's framed and navigates itself
  to `Home/LogOut`, **killing the whole session** (~5-10s in). So browser-mode
  `DomAccess` **fetches** page markup and parses it inertly with `DOMParser`
  (scripts never run) instead of framing it. CDP mode navigates top-level,
  which doesn't framebust.
- **Data provenance (Happy Together / Care Everywhere):** a portal aggregates
  records from other orgs the patient has visited (via `*/LoadExternal`
  endpoints; `conversations/GetOrganizations` lists them). Items are tagged
  with `organizationName` (the source org name, e.g. "Org A" vs "Org B") and
  often `isExternal` in ~9 domains (meds, visits, care-team, immunizations,
  health-summary, covid, item-feed, referrals, messages). **Messages are tagged
  by the *delivering* portal, not the clinical source — unreliable.** External
  data is often a summarized C-CDA-derived view, so a patient's *native*
  export is higher fidelity. If merging exports, dedupe/label by source org.
- **Proxy / multi-patient:** a login may have proxy access to others (children,
  dependents). Switch context via
  `GET <prefix>/inside.asp?mode=proxyswitch&action=switchcontext&src=0&eid=<EID>`
  (EIDs come from the home proxy-menu `switchcontext` links). **Return to self
  with `GET <prefix>/inside.asp?mode=self`** — NOT `action=switchtoself`, which
  silently no-ops and strands the session on the proxy. After a switch, EVERY
  API returns the active subject's data; verify with
  `FetchHealthSummary.patientFirstName`. CDP `--proxies` automates
  switch→export→restore per subject (`packages/cdp/src/proxy.ts`). When probing
  by hand, do switch+capture+restore as ONE in-page async `eval` so it
  self-restores even if your driver dies. Browser mode needs none of this — the
  user navigates to the proxied record in the UI, then runs the bundle.
- **C-CDA (`--ccda`):** async server-side generation. Request via
  `record-download/GetDownloadStarted` (mode `allVisits`), poll
  `requested-records/GetReleaseRecords` for a ready `type:"VDT"`,
  `isDownloadable:"1"` record, then download bytes from
  `<prefix>/Documents/Released/Download` (in-page fetch → base64 → unzip). The
  UI download-manager path was unreliable headlessly; direct fetch works.
- **Dead ends (don't re-chase without new evidence):** `Scheduling/
  GetSchedulingWorkflowData` is the scheduling *wizard's UI config*, not
  appointments (those are in visits). Billing exposes **no** JSON API from its
  pages on the instances tried — it's server-rendered; the billing DOM snapshot
  is the ceiling without deeper work.
- **CDP under Bun:** a browser-automation library's CDP-attach hangs under Bun
  (its bundled ws never upgrades), so `packages/cdp` speaks **raw CDP over
  Bun's native WebSocket**. That means we implement things libraries gave for
  free: auto-dismiss `Page.javascriptDialogOpening` (a dialog blocks every
  `Runtime.evaluate` forever), a client-side timeout on every `send()`, and a
  requestId-tracked networkidle that clears on navigation (a bare counter leaks
  when navigation purges in-flight requests → every section burns the full 45s
  timeout, ~10x slowdown).

## Working with the user & safety

- **PHI never enters git.** `export*/`, `sample-exports/`, `*.zip`, `.venv`,
  `node_modules`, `dist` are git-ignored. Exports are written locally only.
  Before any commit, confirm no PHI/secrets are staged.
- **Proxy switching is reversible but stateful.** Always restore to self and
  verify; never leave the user's session on a proxy. If auto-restore fails,
  tell the user to click their own name in the proxy menu (one click).
- **Superseded code is deleted, not archived** (project policy). Git history is
  the archive; don't create `legacy/`/`attic/`.
- **Publishing/sending anything** derived from an export means distributing PHI
  — don't, unless the user explicitly directs it to a specific destination.
