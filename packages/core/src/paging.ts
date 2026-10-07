/**
 * One paging loop for every list endpoint, so they all follow the same rules —
 * learned the hard way on live portals (Oct 2026):
 *
 *  1. ONLY the server's own end signal means "complete" (completion flags,
 *     nextLineToParse === -1, hasMore… false). A big page-size request is not
 *     proof: test-results GetList capped at a size the portal chose; message
 *     threads defaulted to 5 messages; the third-party access log ran 635
 *     pages / 10k entries where the old loop stopped at 2.
 *  2. A repeated cursor is NOT an end signal — the third-party access log keeps
 *     `nextLineToParse: 1` while serving new rows on every call.
 *  3. A page that adds nothing new is NOT an end signal either — 6 of those 635
 *     pages were all-duplicates mid-stream. Only several in a row (maxDryPages)
 *     stop the loop, as a backstop.
 *  4. For long, time-ordered lists, progress is how far BACK the list has
 *     reached (`frontier`), not wall-clock time: a portal that keeps reaching
 *     older entries is still delivering, however long it takes. Stalling
 *     (maxDryPages pages reaching no further back) is what stops it.
 *  5. Every stop that isn't the server's end signal (backstop, page bound,
 *     failed request, aborted run, missing cursor) records an `incomplete` row,
 *     so GAPS.md says so instead of the export looking complete.
 */
import type { PhaseCtx } from "./ctx";

export interface PageParse<I, C> {
  items: I[];
  /** The server said this is the last page. */
  end: boolean;
  /** Cursor for the next request; undefined = the server gave none. */
  next?: C;
  /** Informational note when `end` was inferred (e.g. no completion flags). */
  endNote?: string;
}

export interface SweepOpts<I, C> {
  ctx: PhaseCtx;
  domain: string;
  /** Label for the completeness row, e.g. "GetList" or "third-party/GetEntries". */
  endpoint: string;
  first: C;
  /** One request. Return the parsed JSON, or null when the request failed. */
  fetchPage(cursor: C, page: number): Promise<unknown | null>;
  /** null = the payload has a shape we don't recognize (recorded as incomplete). */
  parse(json: unknown, cursor: C): PageParse<I, C> | null;
  /** Identity for dedupe across pages. */
  key(item: I): string;
  maxPages?: number;
  maxDryPages?: number;
  /** Progress measure for time-ordered lists (smaller = further back, e.g. a
   *  timestamp). When set, a "dry" page is one that reaches no further back,
   *  instead of one that adds no new items. */
  frontier?(item: I): number | undefined;
  /** Called after each page with the running totals (for a progress line). */
  onPage?(unique: number, frontier: number | undefined, pages: number): void;
  /** Record a summary row even when complete (default true). */
  recordComplete?: boolean;
}

export interface SweepResult<I> {
  items: I[];
  complete: boolean;
  reason: string;
  pages: number;
}

export async function sweep<I, C>(o: SweepOpts<I, C>): Promise<SweepResult<I>> {
  const maxPages = o.maxPages ?? 2000;
  const maxDry = o.maxDryPages ?? 5;
  const seen = new Set<string>();
  const items: I[] = [];
  let cursor = o.first;
  let pages = 0;
  let dry = 0;
  let complete = false;
  let front: number | undefined;
  let reason = `page bound reached (${maxPages} pages) while the server still reported more`;
  for (let page = 0; page < maxPages; page++) {
    if (o.ctx.signal.aborted) {
      reason = `run stopped (${o.ctx.signal.reason}) before the list finished`;
      break;
    }
    if (o.ctx.stopRequested()) {
      reason = "stopped by you before the list finished";
      break;
    }
    let json: unknown | null;
    try {
      json = await o.fetchPage(cursor, page);
    } catch (e) {
      json = null;
      o.ctx.log(`   ${o.endpoint} page ${page} err ${e}`);
    }
    if (json == null) {
      reason = `request for page ${page + 1} failed`;
      break;
    }
    const p = o.parse(json, cursor);
    if (!p) {
      reason = `page ${page + 1} had an unrecognized shape`;
      break;
    }
    pages++;
    let fresh = 0;
    let advanced = false;
    for (const it of p.items) {
      const k = o.key(it);
      if (!seen.has(k)) {
        seen.add(k);
        items.push(it);
        fresh++;
      }
      const f = o.frontier?.(it);
      if (f !== undefined && Number.isFinite(f) && (front === undefined || f < front)) {
        front = f;
        advanced = true;
      }
    }
    o.onPage?.(items.length, front, pages);
    if (p.end) {
      complete = true;
      reason = p.endNote ?? "server reported the end of the list";
      break;
    }
    const progressed = o.frontier ? advanced : fresh > 0;
    dry = progressed ? 0 : dry + 1;
    if (dry >= maxDry) {
      reason = o.frontier
        ? `${maxDry} consecutive pages reached no further back while the server still reported more`
        : `${maxDry} consecutive pages added nothing new while the server still reported more`;
      break;
    }
    if (p.next === undefined) {
      reason = "server reported more but gave no continuation cursor";
      break;
    }
    cursor = p.next;
  }
  const note = `${items.length} unique over ${pages} page(s): ${reason}`;
  if (!complete) {
    o.ctx.rec(o.domain, `${o.endpoint}[completeness]`, null, `INCOMPLETE — ${note}`, { outcome: "incomplete" });
  } else if (o.recordComplete !== false) {
    o.ctx.rec(o.domain, `${o.endpoint}[completeness]`, { status: 200, body: "" }, note); // a summary row
  }
  return { items, complete, reason, pages };
}
