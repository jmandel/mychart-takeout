import { isLoggedOutUrl, type FetchInit, type McResponse, type MyChartClient } from "@mychart/core";
import { step } from "./journal";

/** First path segment of a MyChart app URL ("/MyChart", "/MyChart-PRD", …). */
export function derivePrefix(pathname: string, fallback = "/MyChart"): string {
  const seg = pathname.split("/").filter(Boolean)[0];
  return seg ? `/${seg}` : fallback;
}

/** Path only (drop origin + query) — journal entries carry no PHI. */
function journalPath(u: string): string {
  try {
    return new URL(u, location.href).pathname;
  } catch {
    return u.split("?")[0] || u;
  }
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
    if (init.timeoutMs) r.signal = AbortSignal.timeout(init.timeoutMs);
    return r;
  }

  /** Normalize an abort-by-timeout so Mc can classify it (message: "timeout…"). */
  private static rethrow(e: unknown, p: string, timeoutMs?: number): never {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      step(`✗ timeout after ${timeoutMs}ms ${p}`);
      throw new Error(`timeout after ${timeoutMs}ms: ${p}`);
    }
    step(`✗ network-error ${p}`);
    throw e;
  }

  async fetchText(pathOrUrl: string, init: FetchInit = {}): Promise<McResponse> {
    const p = journalPath(pathOrUrl);
    step(`→ ${init.method ?? (init.body ? "POST" : "GET")} ${p}`); // persisted BEFORE the fetch
    let r: Response;
    try {
      r = await fetch(this.resolve(pathOrUrl), this.init(init));
    } catch (e) {
      BrowserClient.rethrow(e, p, init.timeoutMs);
    }
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    step(`✓ ${r.status} ${p}${isLoggedOutUrl(r.url) ? " ← LOGGED OUT (redirected to login)" : ""}`);
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
    const p = journalPath(pathOrUrl);
    step(`→ GET(bytes) ${p}`);
    let r: Response;
    try {
      r = await fetch(this.resolve(pathOrUrl), this.init(init));
    } catch (e) {
      BrowserClient.rethrow(e, p, init.timeoutMs);
    }
    step(`✓ ${r.status} (bytes) ${p}${isLoggedOutUrl(r.url) ? " ← LOGGED OUT" : ""}`);
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  }

  async getPageToken(): Promise<string | null> {
    const el = document.querySelector('input[name="__RequestVerificationToken"]');
    const v = el instanceof HTMLInputElement ? el.value : "";
    return v || null;
  }
}
