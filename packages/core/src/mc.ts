import type { FetchInit, McResponse, MyChartClient } from "./types";

/** Extract a CSRF token from a /Home/CSRFToken response body: the hidden input
 *  (older Epic), else a bare token string (some newer builds). */
export function parseCsrfToken(body: string): string | null {
  const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(body);
  if (m) return m[1]!;
  const t = (body ?? "").trim();
  // A bare token: one non-whitespace chunk, no HTML/JSON, plausible length.
  if (t.length >= 16 && t.length <= 1024 && !/[<>{}"\s]/.test(t)) return t;
  return null;
}

/**
 * Authenticated MyChart API wrapper (port of harness/mychart.py mc_* helpers).
 * Caches the __RequestVerificationToken and attaches it to every call. Paths
 * given to the mc* methods are PREFIX-RELATIVE (no leading slash), e.g.
 * "api/test-results/GetList"; absolute http(s) URLs and already-/-prefixed
 * paths pass through untouched.
 */
/** A response URL that means the session died (bounced to login/logout). */
export function isLoggedOutUrl(url: string): boolean {
  return /\/Authentication\/Login|action=logout|\/bye\.asp/i.test(url || "");
}

/** Per-call time budget; a hung endpoint costs at most this. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Retries are cheaper: a healthy instance answers in ~2s, so 10s is generous. */
export const RETRY_TIMEOUT_MS = 10_000;
/** The breaker's confirm probe must be fast — it runs when things look bad. */
export const PROBE_TIMEOUT_MS = 8_000;
/** Consecutive hard failures before the breaker asks a probe to confirm. */
const PROBE_AT_FAILURES = 3;
/** Consecutive hard failures that trip the breaker even with a live probe. */
const TRIP_REGARDLESS_AT = 8;

/**
 * Shared run-health state: consecutive hard failures (timeout/network/5xx feed
 * it, any success resets it) and an optional wall-clock deadline. Failures in
 * this domain are correlated (dead session, WAF block, dropped network), so the
 * 2nd and 3rd timeout carry no new information — the breaker converts "N slow
 * failures" into "a few, then instant skips with a recorded reason".
 */
export interface RunHealth {
  consecutiveFailures: number;
  /** Epoch ms after which no new calls start (0 = no deadline). */
  deadlineAt: number;
  /** Next failure count at which to run the confirm probe. */
  probeAt: number;
}

export function makeRunHealth(runBudgetMs = 0): RunHealth {
  return {
    consecutiveFailures: 0,
    deadlineAt: runBudgetMs > 0 ? Date.now() + runBudgetMs : 0,
    probeAt: PROBE_AT_FAILURES,
  };
}

export interface McOpts {
  /**
   * Token already verified by detection — seeds the cache so the run's first
   * request is a known-good call, not a fresh token fetch that might disagree
   * with what detection validated.
   */
  initialToken?: string | null;
  health?: RunHealth;
}

export class Mc {
  private tok: string | null = null;
  private readonly health: RunHealth;

  /** `signal` (from makeCtx) is tripped the first time a call bounces to login. */
  constructor(
    readonly client: MyChartClient,
    private readonly signal?: { aborted: boolean; reason: string },
    opts: McOpts = {},
  ) {
    this.tok = opts.initialToken ?? null;
    this.health = opts.health ?? makeRunHealth();
  }

  url(path: string): string {
    if (path.startsWith("http") || path.startsWith("/")) return path;
    return `${this.client.prefix}/${path}`;
  }

  async token(refresh = false): Promise<string | null> {
    if (this.tok && !refresh) return this.tok;
    // 1) The endpoint that older Epic serves as an HTML hidden input.
    const r = await this.client.fetchText(`${this.client.prefix}/Home/CSRFToken`, {
      method: "GET",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    // A logged-out session redirects this to the login page (whose HTML also
    // has a __RequestVerificationToken) — don't adopt that token.
    let tok = isLoggedOutUrl(r.url) ? null : parseCsrfToken(r.body);
    // 2) Newer Epic ("PX") returns no parseable token there, but embeds it in
    //    the page — read it from the DOM when the driver can (browser/CDP).
    if (!tok && this.client.getPageToken) {
      tok = await this.client.getPageToken().catch(() => null);
    }
    this.tok = tok;
    return this.tok;
  }

  /** Throws before any network I/O when the run must not continue. */
  private guard(path: string): void {
    if (this.signal?.aborted) throw new Error(`skipped (${this.signal.reason}): ${path}`);
    if (this.health.deadlineAt && Date.now() > this.health.deadlineAt) {
      if (this.signal && !this.signal.aborted) {
        this.signal.aborted = true;
        this.signal.reason = "run-deadline";
      }
      throw new Error(`skipped (run-deadline): ${path}`);
    }
  }

  private trip(reason: string): void {
    if (this.signal && !this.signal.aborted) {
      this.signal.aborted = true;
      this.signal.reason = reason;
    }
  }

  /**
   * Consecutive hard failures reached a threshold: confirm with a cheap GET
   * before tripping (one slow endpoint shouldn't kill the run), but past
   * TRIP_REGARDLESS_AT stop even if probes keep passing — grinding through a
   * catalog of failures at full timeout each is never right.
   */
  private async maybeTrip(path: string, kind: string): Promise<void> {
    const n = this.health.consecutiveFailures;
    if (!this.signal || this.signal.aborted) return;
    if (n >= TRIP_REGARDLESS_AT) {
      this.trip(`circuit-open: ${n} consecutive failures, latest ${kind} at ${path}`);
      return;
    }
    if (n < this.health.probeAt) return;
    this.health.probeAt = n + PROBE_AT_FAILURES;
    let probeOk = false;
    try {
      // Home (not CSRFToken): served on every Epic generation; signed-out or
      // blocked sessions bounce it, so it separates "instance down" from "one
      // slow endpoint" without any token-bearing POST.
      const p = await this.client.fetchText(`${this.client.prefix}/Home`, {
        method: "GET",
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      probeOk = p.status < 500 && !isLoggedOutUrl(p.url);
    } catch {
      probeOk = false;
    }
    if (!probeOk) this.trip(`circuit-open: ${kind} at ${path} (confirm probe failed too)`);
  }

  private async call(path: string, init: FetchInit, attempt = 0): Promise<McResponse> {
    this.guard(path);
    const tok = await this.token();
    let res: McResponse;
    try {
      res = await this.client.fetchText(this.url(path), {
        ...init,
        timeoutMs: attempt > 0 ? RETRY_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          __RequestVerificationToken: tok ?? "",
          Accept: "application/json",
          ...init.headers,
        },
      });
    } catch (e) {
      const kind = /timeout/i.test(String(e)) ? "timeout" : "network-error";
      const wasHealthy = this.health.consecutiveFailures === 0;
      this.health.consecutiveFailures++;
      // Retry once, cheaper, and only when the world looked healthy until this
      // request — a retry after other recent failures spends 10s to learn nothing.
      if (wasHealthy && attempt === 0) return this.call(path, init, 1);
      await this.maybeTrip(path, kind);
      throw new Error(`${kind}: ${path}`);
    }
    try {
      res.json = JSON.parse(res.body);
    } catch {
      res.json = undefined;
    }
    // Session died mid-run: record the culprit once and let phases/the driver
    // stop instead of saving 30+ login-page shells as "data".
    if (this.signal && !this.signal.aborted && isLoggedOutUrl(res.url)) {
      this.signal.aborted = true;
      this.signal.reason = path;
    }
    if (isLoggedOutUrl(res.url)) return res;
    if (res.status >= 500) {
      this.health.consecutiveFailures++;
      await this.maybeTrip(path, "server-error");
    } else {
      this.health.consecutiveFailures = 0;
      this.health.probeAt = PROBE_AT_FAILURES;
    }
    return res;
  }

  /** POST JSON to an api endpoint (mc_api). */
  api(path: string, body: unknown = {}): Promise<McResponse> {
    return this.call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** GET with token header (mc_get). */
  get(path: string): Promise<McResponse> {
    return this.call(path, { method: "GET" });
  }

  /** POST x-www-form-urlencoded (mc_form). */
  form(path: string, form: string): Promise<McResponse> {
    return this.call(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form,
    });
  }

  /** POST with token header and NO body / NO content-type (mc_nobody). */
  nobody(path: string): Promise<McResponse> {
    return this.call(path, { method: "POST" });
  }
}
