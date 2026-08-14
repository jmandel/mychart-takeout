import { Buffer } from "node:buffer";
import type { FetchInit, McResponse, MyChartClient } from "@mychart/core";

/** Only the bit of the page we use — lets tests inject a stub. */
export interface EvalPage {
  /** Evaluate a JS expression string in-page (promises awaited). */
  evaluate(expression: string): Promise<unknown>;
}

interface RawText {
  status: number;
  content_type: string | null;
  url: string;
  headers: Record<string, string>;
  body: string;
}
interface RawBytes {
  status: number;
  b64: string;
}

/**
 * MyChartClient over CDP — port of harness/mychart.py Session.api(): evaluates
 * an in-page fetch so real cookies/headers/WAF fingerprint apply. Relative
 * paths resolve against the derived session origin. Arguments are embedded
 * into the expression as JSON (Runtime.evaluate has no structured-arg call).
 */
export class CdpClient implements MyChartClient {
  constructor(
    private page: EvalPage,
    readonly origin: string,
    readonly prefix: string,
  ) {}

  private abs(pathOrUrl: string): string {
    return pathOrUrl.startsWith("http") ? pathOrUrl : this.origin + pathOrUrl;
  }

  async fetchText(pathOrUrl: string, init: FetchInit = {}): Promise<McResponse> {
    const url = this.abs(pathOrUrl);
    const expr = `(async () => {
      const a = ${JSON.stringify({ url, init })};
      const opt = {
        credentials: "include",
        headers: Object.assign({ "X-Requested-With": "XMLHttpRequest" }, a.init.headers || {}),
      };
      if (a.init.method) opt.method = a.init.method;
      if (a.init.body !== undefined && a.init.body !== null) opt.body = a.init.body;
      if (a.init.timeoutMs) opt.signal = AbortSignal.timeout(a.init.timeoutMs);
      let r;
      try {
        r = await fetch(a.url, opt);
      } catch (e) {
        const kind = e && (e.name === "TimeoutError" || e.name === "AbortError")
          ? "timeout after " + a.init.timeoutMs + "ms"
          : "network-error";
        throw new Error(kind + ": " + a.url);
      }
      const text = await r.text();
      const hs = {};
      r.headers.forEach((v, k) => (hs[k] = v));
      return { status: r.status, content_type: r.headers.get("content-type"), url: r.url, headers: hs, body: text };
    })()`;
    const raw = (await this.page.evaluate(expr)) as RawText;
    return {
      status: raw.status,
      contentType: raw.content_type,
      url: raw.url,
      headers: raw.headers,
      body: raw.body,
    };
  }

  async fetchBytes(
    pathOrUrl: string,
    init: FetchInit = {},
  ): Promise<{ status: number; bytes: Uint8Array }> {
    const url = this.abs(pathOrUrl);
    const expr = `(async () => {
      const a = ${JSON.stringify({ url, init })};
      const opt = { credentials: "include", headers: Object.assign({}, a.init.headers || {}) };
      if (a.init.method) opt.method = a.init.method;
      if (a.init.body !== undefined && a.init.body !== null) opt.body = a.init.body;
      if (a.init.timeoutMs) opt.signal = AbortSignal.timeout(a.init.timeoutMs);
      let r;
      try {
        r = await fetch(a.url, opt);
      } catch (e) {
        const kind = e && (e.name === "TimeoutError" || e.name === "AbortError")
          ? "timeout after " + a.init.timeoutMs + "ms"
          : "network-error";
        throw new Error(kind + ": " + a.url);
      }
      const b = new Uint8Array(await r.arrayBuffer());
      let s = "";
      const CH = 0x8000;
      for (let i = 0; i < b.length; i += CH) {
        s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + CH)));
      }
      return { status: r.status, b64: btoa(s) };
    })()`;
    const raw = (await this.page.evaluate(expr)) as RawBytes;
    return { status: raw.status, bytes: new Uint8Array(Buffer.from(raw.b64, "base64")) };
  }

  async getPageToken(): Promise<string | null> {
    const v = (await this.page.evaluate(
      `(() => { const e = document.querySelector('input[name="__RequestVerificationToken"]');` +
        ` return e ? e.value : ""; })()`,
    )) as string;
    return v || null;
  }
}
