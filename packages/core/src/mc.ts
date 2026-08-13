import type { FetchInit, McResponse, MyChartClient } from "./types";

/**
 * Authenticated MyChart API wrapper (port of harness/mychart.py mc_* helpers).
 * Caches the __RequestVerificationToken from <prefix>/Home/CSRFToken and
 * attaches it to every call. Paths given to the mc* methods are PREFIX-
 * RELATIVE (no leading slash), e.g. "api/test-results/GetList"; absolute
 * http(s) URLs and already-/-prefixed paths pass through untouched.
 */
export class Mc {
  private tok: string | null = null;

  constructor(readonly client: MyChartClient) {}

  url(path: string): string {
    if (path.startsWith("http") || path.startsWith("/")) return path;
    return `${this.client.prefix}/${path}`;
  }

  async token(refresh = false): Promise<string | null> {
    if (this.tok && !refresh) return this.tok;
    const r = await this.client.fetchText(`${this.client.prefix}/Home/CSRFToken`, {
      method: "GET",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(r.body);
    this.tok = m?.[1] ?? null;
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
