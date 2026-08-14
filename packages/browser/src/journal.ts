/**
 * A run journal persisted to sessionStorage, so it survives the failure modes
 * WITHIN the tab but auto-clears when the tab closes (nothing lingers):
 *  - soft: the session dies but the widget stays (fetches return login pages);
 *  - hard: MyChart's own JS reloads the tab to login and tears our widget down
 *          — sessionStorage survives that same-tab navigation (and the re-login).
 *
 * Every request is logged before AND after it runs. If the tab reloads mid-
 * request, the last entry is a "→ start" with no "✓ done" — that request is the
 * culprit. On the next run we detect the unfinished journal and offer to copy
 * it, so a repeatable failure is diagnosable without watching it happen.
 *
 * Entries are structural only (method + path, no query/PHI, status codes).
 */
const KEY = "mychart_takeout_journal";
const MAX_EVENTS = 500;
const RECENT_MS = 3 * 60 * 60 * 1000; // ignore a stale run from earlier in a long-lived tab

export type RunStatus = "running" | "logged-out" | "error" | "done";

export interface Journal {
  runId: string;
  host: string;
  prefix: string;
  startedAt: number;
  updatedAt: number;
  status: RunStatus;
  exportStarted: boolean;
  events: string[];
}

function load(): Journal | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Journal) : null;
  } catch {
    return null;
  }
}
function save(j: Journal): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(j));
  } catch {
    /* quota / disabled storage — journaling is best-effort */
  }
}

let cur: Journal | null = null;

/** Read the PREVIOUS journal (call before startRun overwrites it). */
export function previousJournal(): Journal | null {
  return load();
}

export function startRun(host: string, prefix: string): void {
  cur = {
    runId: `${host}-${new Date().toISOString()}`,
    host,
    prefix,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    exportStarted: false,
    events: [],
  };
  save(cur);
}

function stamp(): string {
  return cur ? `+${((Date.now() - cur.startedAt) / 1000).toFixed(1)}s` : "";
}

export function step(msg: string): void {
  if (!cur) return;
  cur.events.push(`${stamp()} ${msg}`);
  if (cur.events.length > MAX_EVENTS) cur.events = cur.events.slice(-MAX_EVENTS);
  cur.updatedAt = Date.now();
  save(cur);
}

export function markExportStarted(): void {
  if (!cur) return;
  cur.exportStarted = true;
  step("== EXPORT STARTED ==");
}

export function finish(status: RunStatus, note = ""): void {
  if (!cur) return;
  cur.status = status;
  step(`== FINISHED: ${status}${note ? ` (${note})` : ""} ==`);
}

/** An unfinished run worth surfacing on the next load (recent, real export). */
export function crashedRun(prev: Journal | null): Journal | null {
  if (!prev) return null;
  if (Date.now() - prev.updatedAt > RECENT_MS) return null;
  const unfinished = prev.status === "running" || prev.status === "logged-out" || prev.status === "error";
  return unfinished && prev.exportStarted ? prev : null;
}

/** The request that likely killed the session: the last "→" with no "✓". */
export function likelyCulprit(j: Journal): string | null {
  for (let i = j.events.length - 1; i >= 0; i--) {
    const e = j.events[i]!;
    if (/✓/.test(e)) return null; // last request completed — a hard reload wasn't mid-request
    const m = /→\s+(.*)$/.exec(e);
    if (m) return m[1]!;
  }
  return null;
}

export function formatJournal(j: Journal): string {
  const lines = [
    "# mychart-takeout run journal",
    "note: structural only (method + path, status codes) — no PHI. Share PRIVATELY with Josh.",
    `host: ${j.host}${j.prefix}`,
    `status: ${j.status}`,
    `started: ${new Date(j.startedAt).toISOString()}`,
    `culprit (last request with no completion): ${likelyCulprit(j) ?? "(none — last request completed)"}`,
    "",
    ...j.events,
  ];
  return lines.join("\n");
}
