/**
 * Shared contracts for the isomorphic core.
 *
 * `packages/core` must run unmodified in a Bun process (CDP mode) and inside
 * a browser page (console/bookmarklet mode). Nothing in core may import
 * node builtins or browser-automation libraries, use Bun globals, or touch
 * the DOM — everything environmental arrives through these interfaces.
 * (Enforced by test/isomorphism.test.ts.)
 */

/** HTTP-ish response as seen from inside the authenticated session. */
export interface McResponse {
  status: number;
  contentType: string | null;
  url: string;
  headers?: Record<string, string>;
  body: string;
  /** Parsed JSON body when parseable (set by Mc wrappers), else undefined. */
  json?: unknown;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** Pre-serialized body. JSON serialization happens in Mc, not here. */
  body?: string;
  /**
   * Per-request time budget. Transports abort the request past it and throw an
   * error whose message starts with "timeout" — one hung endpoint must not
   * stall the whole run (Mc turns these into breaker strikes, not crashes).
   */
  timeoutMs?: number;
}

/**
 * Transport: how a same-origin request reaches MyChart.
 * Implementations: packages/cdp (evaluate fetch() inside the attached page),
 * packages/browser (the page's own fetch with credentials:'include').
 * Implementations MUST send session cookies and resolve non-absolute paths
 * against `origin`.
 */
export interface MyChartClient {
  /** e.g. "https://mychart.example.org" */
  readonly origin: string;
  /** App path prefix, leading slash, no trailing slash. e.g. "/MyChart" */
  readonly prefix: string;
  fetchText(pathOrUrl: string, init?: FetchInit): Promise<McResponse>;
  fetchBytes(
    pathOrUrl: string,
    init?: FetchInit,
  ): Promise<{ status: number; bytes: Uint8Array }>;
  /**
   * Read the __RequestVerificationToken embedded in the current page, if the
   * environment can (browser DOM / CDP evaluate). Newer Epic ("PX") builds
   * don't return it from /Home/CSRFToken, so this is the reliable source.
   */
  getPageToken?(): Promise<string | null>;
}

/** Output: where export files land (fs tree, in-memory zip, ...). */
export interface Sink {
  saveText(rel: string, text: string): Promise<void>;
  saveBytes(rel: string, bytes: Uint8Array): Promise<void>;
}

/** One row of the run manifest (mirrors export.py's Exporter.rec). */
export interface ManifestEntry {
  domain: string;
  endpoint: string;
  status: number | null;
  bytes: number;
  note: string;
  /** Classified outcome (set by ctx.rec via classifyOutcome); absent = summary row. */
  outcome?: string;
  [extra: string]: unknown;
}

/**
 * A rendered app page, used for link harvesting (test-results eorderid
 * fallback). CDP mode: real navigation in the attached tab.
 */
export interface SectionPage {
  html(): Promise<string>;
  text(): Promise<string>;
  /** getAttribute('href') of every element matching a CSS selector. */
  hrefs(selector: string): Promise<(string | null)[]>;
}

export interface DomAccess {
  withSection<T>(
    path: string,
    settleMs: number,
    fn: (page: SectionPage) => Promise<T>,
  ): Promise<T>;
}
