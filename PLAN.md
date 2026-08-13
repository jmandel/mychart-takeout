# Plan: shared-core Bun/TypeScript port

Goal: one isomorphic TypeScript codebase that (a) agents and the CLI drive
over CDP against a live authenticated browser — enabling automation,
self-healing, inline fixes, and noticing missing data — and (b) compiles into
a self-contained console-pasteable / bookmarkletable script that produces the
same export as a downloadable ZIP.

**Load-bearing rule:** `packages/core` has **zero environment imports** — no
`fs`, no `playwright`, no `document`, no `Bun.*`. Transport (how `fetch`
reaches MyChart) and sink (where files go) are injected. The only
deliberately in-page module is `core/src/inpage.ts` (DOM tricks), shipped
into the page by *both* drivers.

Reference implementation: `export.py` + `harness/mychart.py` +
`harness/build_reportlib.py` (Python, working, stays untouched until parity).

**Status 2026-08-13:** P0–P5 complete. 128 tests green (unit + golden +
two end-to-end suites in real headless Chromium against `tools/mock-mychart`
— browser-bundle mode and raw-CDP mode). Live parity ran against a real
session: zero structured-JSON key diffs, identical record counts, runtime
within 4% of the Python; the Python implementation was then deleted (git
history is the archive). Notable port learnings: playwright's CDP-attach
websocket hangs under Bun (we speak raw CDP over the native WebSocket);
raw CDP needs its own dialog auto-dismiss, per-command deadlines, and
requestId-tracked networkidle (a bare counter leaks on navigation). P6
partially banked early: origin/prefix derived from the page, timezone from
`Intl`, prefix-relative catalog, mock server `--prefix` variant.

## Architecture

```
packages/core/          isomorphic — Bun process OR browser page
  src/types.ts            MyChartClient, McResponse, Sink, PhaseCtx, DomAccess
  src/mc.ts               CSRF token cache + mcApi/mcGet/mcForm/mcNobody wrappers
  src/store.ts            ExportStore: writes via Sink, retains structured JSON
                          in memory so later phases + report read without fs
  src/catalog.ts          endpoint tables as data (SIMPLE/CLASSIC/SECTIONS)
  src/phases/*.ts         structured, testResults, visits, messages,
                          flowsheets, ccda, dom
  src/report/*.ts         summary/index/manifest/readme builders (pure)
  src/inpage.ts           in-page helpers (iframe section load, link harvest)
packages/cdp/           Bun-only driver
  src/session.ts          playwright-core connectOverCDP, page pick, evaluate bridge
  src/netlog.ts           response logger → raw_network/responses.jsonl + bodies/
  src/salvage.ts          salvage phase (reads netlog; CDP-only by nature)
  src/fsSink.ts           filesystem Sink
packages/browser/       in-page driver
  src/client.ts           window.fetch MyChartClient
  src/zipSink.ts          in-memory zip Sink (fflate) → Blob download
  src/overlay.ts          progress UI + start/cancel
  src/main.ts             entry: attach overlay, run phases, hand over ZIP
apps/cli/               bun CLI: whereami|targets|goto|eval|api|snapshot|export|report
apps/web-build/         emits dist/console.js + dist/bookmarklet.txt
tools/mock-mychart/     Bun.serve mock instance w/ synthetic (non-PHI) data
                        — CI target for core + browser integration tests
```

Where code executes: phases run **in Bun** in CDP mode (agent keeps
fine-grained control, checkpointing, retry) with each API call bridged
through one in-page `fetch`; the **same phase code** runs **in the page** in
browser mode. `inpage.ts` runs in-page in both modes.

## Phases

### P0 — Docs + repo hygiene ✅ first
1. **Comprehensive README.md** explaining what the project is/does and its
   modes of use (done before anything else).
2. `PLAN.md` (this file).
3. `git init`; `.gitignore` excludes `export*/` (PHI), `.venv/`,
   `__pycache__/`, `node_modules/`, `dist/`; secret/PHI scan of tracked
   files; initial commit of app/scripts/docs only.

**Tests/checks:**
- `git status` shows no `export*/`, `.venv` paths tracked.
- `git grep -iE 'password|secret|token=|bearer '` over the index returns
  only code that *handles* tokens (no literals).
- No file in the index contains real MRNs/CSNs/names (manual review of the
  short file list).

### P1 — Workspace scaffold + core contracts
- Root `package.json` with bun workspaces; strict shared `tsconfig`.
- Author `types.ts`, `mc.ts`, `store.ts`, `catalog.ts` (tables transcribed
  from the **current** `export.py`, including the care-team/covid
  POST-with-query-params "nobody" variants).

**Tests/checks:**
- `bun install` clean; `bunx tsc --noEmit` clean.
- `bun test` runs (mc.ts unit tests: CSRF parse, header injection, form vs
  json vs nobody call shapes against a FakeClient).
- Isomorphism guard: a script greps `packages/core/src` for
  `fs|playwright|Bun\.|process\.` imports and fails if found (also enforced
  later by the web build succeeding).

### P2 — Port core phases + report builder
- Phases ported 1:1 from `export.py`, same file names/layout in the export
  tree, reading cross-phase data from the ExportStore (not fs).
- Report builder ported from `build_reportlib.py` as pure functions.
- Synthetic fixture patient ("Alex Example") covering every shape the code
  navigates: results with components + narratives, visits with AVS/notes,
  message threads, flowsheets, pagination (`SerializedIndex`/`HasMoreData`),
  empty sections.

**Tests/checks:**
- Unit: each phase against FakeClient+fixtures → expected file set + manifest
  entries (including gap notes for shell responses).
- Pagination: LoadPast loop terminates on HasMoreData=false, on repeated
  SerializedIndex, and at the page cap; flowsheet reader stops when no new
  ISO timestamps.
- Golden: report builder on the fixture store → byte-stable
  PATIENT_SUMMARY.md/.json, indexes/*.csv, MANIFEST.json.
- Helper parity: `slug`, deep `collect`, visit-meta walk match Python
  semantics on tricky inputs (unicode, empties, nesting).

### P3 — CDP driver + CLI
- `Session`: connectOverCDP, page selection by host match, evaluate bridge
  implementing MyChartClient, netlog, DomAccess via real navigation,
  salvage, fsSink.
- CLI verbs mirroring `harness/mychart.py`'s (agent probe surface) plus
  `export` with `export.py`-compatible flags, and `report` (rebuild from an
  existing export dir by loading it into the store).

**Tests/checks:**
- Unit: evaluate-bridge + netlog against a stubbed page object; body-file
  extension/content-type mapping (`_ext_for`/`_should_save` parity).
- Integration (no PHI): launch local headless Chromium with
  `--remote-debugging-port` pointed at `tools/mock-mychart`; run
  `bun cli export --out tmp` → expected export tree from synthetic data.
- **Live smoke (manual, documented):** `./launch_browser.sh`, sign in, then
  `bun cli whereami`, `bun cli api /MyChart/Home/CSRFToken`,
  `bun cli export --only structured --out export_ts_smoke` and compare file
  list + JSON top-level keys against the same `--only structured` run of
  `export.py`.

### P4 — Browser driver + console/bookmarklet build
- BrowserClient (window.fetch), zipSink (fflate), overlay, `main.ts`.
- `inpage.ts` iframe DomAccess: load section pages hidden, harvest
  test-result `eorderid` links, capture section HTML/text into the zip.
- Build: single IIFE `dist/console.js`; `dist/bookmarklet.txt` =
  `javascript:` + URL-encoded minified bundle. Size budget asserted.

**Tests/checks:**
- Build succeeds (proves core imports nothing environmental); bundle
  < 300 KB minified; bookmarklet form parses as a URL.
- Integration: playwright loads mock-mychart page, injects `console.js`,
  runs export → unpack produced zip → same file set as P3 integration.
- Manual: paste `console.js` on a real signed-in MyChart tab; verify zip.

### P5 — Parity + cutover
- Full live parity run: bun CLI vs `export.py` on the same session, same
  day: diff file trees, JSON key sets, and record counts in MANIFEST.json.
- Fix divergences; then **delete the Python implementation** (`export.py`,
  `harness/`, `run_export.sh`, `.venv`) — superseded code is eliminated, not
  archived; git history is the archive. `launch_browser.sh` stays (it's CDP
  infrastructure, not Python). Update README accordingly.

**Tests/checks:** the parity diff itself (scripted in `tools/parity.ts`,
output reviewed by hand since data is PHI-local).

### P6 — Cross-instance robustness
- Derive origin + path prefix from the live page URL (kill the hardcoded
  instance base); timezone from `Intl` (kill the hardcoded default tz).
- Outcome classifier on every call: json | spa-shell | redirect-home |
  denied | waf-challenge | http-error → recorded in manifest; end-of-run
  **gaps report** (attempted/succeeded/absent per capability).
- Catalog becomes capability → ordered endpoint variants; per-item resume
  (skip files already in store/sink) for restartable long runs.

**Tests/checks:**
- Unit: classifier on captured response shapes.
- Mock-server variants: prefix `/MyChart-PRD`; several endpoints disabled →
  export still completes, gaps report lists exactly the disabled ones.
- Live: run against a second real instance when available; file gaps as
  fixtures.

### P7 — Later (not scheduled)
- MV3 extension packaging (same bundle; adds downloads UX + screenshots).
- Multi-org (Happy Together) iteration; proxy-context loop (explicit opt-in,
  separate out dirs).
- EHI export phase for instances that enable it; FHIR tier behind a
  registered client.

## Test cadence

Run at every step: `bunx tsc --noEmit` + `bun test` (unit). Run per phase:
the integration tests listed above. Live-session smoke/parity only at P3/P5
milestones (requires a signed-in session; results stay local). CI-able tests
never touch PHI — all fixtures are synthetic.
