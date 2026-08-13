import type { FetchInit, McResponse, MyChartClient } from "@mychart/core";

/** First path segment of a MyChart app URL ("/MyChart", "/MyChart-PRD", …). */
export function derivePrefix(pathname: string, fallback = "/MyChart"): string {
  const seg = pathname.split("/").filter(Boolean)[0];
  return seg ? `/${seg}` : fallback;
}

/**
 * MyChartClient backed by the page's own fetch. Runs inside the authenticated
 * MyChart tab (console paste / bookmarklet), so session cookies and the
 * browser fingerprint come along automatically.
 */
export class BrowserClient implements MyChartClient {
  constructor(
    readonly origin: string,
    readonly prefix: string,
  ) {}

  private resolve(pathOrUrl: string): string {
    if (pathOrUrl.startsWith("http")) return pathOrUrl;
    return new URL(pathOrUrl, this.origin).toString();
  }

  private init(init: FetchInit): RequestInit {
    const r: RequestInit = {
      credentials: "include",
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: init.headers ?? {},
    };
    if (init.body !== undefined) r.body = init.body;
    return r;
  }

  async fetchText(pathOrUrl: string, init: FetchInit = {}): Promise<McResponse> {
    const r = await fetch(this.resolve(pathOrUrl), this.init(init));
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    return {
      status: r.status,
      contentType: r.headers.get("content-type"),
      url: r.url,
      headers,
      body: await r.text(),
    };
  }

  async fetchBytes(
    pathOrUrl: string,
    init: FetchInit = {},
  ): Promise<{ status: number; bytes: Uint8Array }> {
    const r = await fetch(this.resolve(pathOrUrl), this.init(init));
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  }

  async getPageToken(): Promise<string | null> {
    const el = document.querySelector('input[name="__RequestVerificationToken"]');
    const v = el instanceof HTMLInputElement ? el.value : "";
    return v || null;
  }
}
