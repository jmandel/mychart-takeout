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

export class Mc {
  private tok: string | null = null;

  /** `signal` (from makeCtx) is tripped the first time a call bounces to login. */
  constructor(
    readonly client: MyChartClient,
    private readonly signal?: { aborted: boolean; reason: string },
  ) {}

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
    let tok = parseCsrfToken(r.body);
    // 2) Newer Epic ("PX") returns no parseable token there, but embeds it in
    //    the page — read it from the DOM when the driver can (browser/CDP).
    if (!tok && this.client.getPageToken) {
      tok = await this.client.getPageToken().catch(() => null);
    }
    this.tok = tok;
    return this.tok;
  }

  private async call(path: string, init: FetchInit): Promise<McResponse> {
    const tok = await this.token();
    const res = await this.client.fetchText(this.url(path), {
      ...init,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        __RequestVerificationToken: tok ?? "",
        Accept: "application/json",
        ...init.headers,
      },
    });
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
