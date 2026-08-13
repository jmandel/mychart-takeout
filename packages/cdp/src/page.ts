import { mkdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname } from "node:path";
import type { CdpEvents } from "./rawcdp";

export interface GotoOpts {
  waitUntil?: "load" | "domcontentloaded";
  timeout?: number;
}

/**
 * Thin page facade over a raw CDP flat session, exposing the small surface
 * the CLI/driver actually use: url()/title()/goto()/evaluate(expression)/
 * content()/waitForLoadState("networkidle")/waitForTimeout()/screenshot().
 * evaluate() takes a JS EXPRESSION STRING (awaited if it yields a promise).
 */
export class CdpPage {
  private _url: string;
  private inflightIds = new Set<string>();
  private lastSettled = Date.now();
  private loadFired = false;
  private domContentFired = false;

  private constructor(
    readonly conn: CdpEvents,
    readonly sessionId: string,
    initialUrl: string,
  ) {
    this._url = initialUrl;
  }

  static async create(conn: CdpEvents, sessionId: string, initialUrl: string): Promise<CdpPage> {
    const page = new CdpPage(conn, sessionId, initialUrl);
    conn.on(
      "Page.frameNavigated",
      (p: { frame: { url: string; parentId?: string } }) => {
        if (!p.frame.parentId) {
          page._url = p.frame.url;
          // New document: outstanding requests are purged by the browser and
          // their loadingFinished never arrives — drop them or networkidle
          // becomes permanently undetectable (each section then burns the
          // full timeout; observed live at ~10x python's dom-phase time).
          page.inflightIds.clear();
          page.lastSettled = Date.now();
        }
      },
      sessionId,
    );
    conn.on("Page.loadEventFired", () => (page.loadFired = true), sessionId);
    conn.on("Page.domContentEventFired", () => (page.domContentFired = true), sessionId);
    // A JS dialog (confirm/beforeunload/...) blocks the renderer and with it
    // every Runtime.evaluate; automation libraries auto-dismiss, so must we.
    conn.on(
      "Page.javascriptDialogOpening",
      (p: { type: string }) => {
        void conn
          .send("Page.handleJavaScriptDialog", { accept: p.type === "beforeunload" }, sessionId)
          .catch(() => {});
      },
      sessionId,
    );
    // in-flight tracking for the networkidle approximation, keyed by
    // requestId so duplicate/missing events can't skew a bare counter;
    // streaming types never emit loadingFinished, so they don't count.
    conn.on(
      "Network.requestWillBeSent",
      (p: { requestId?: string; type?: string }) => {
        if (!p?.requestId) return;
        if (p.type === "EventSource" || p.type === "WebSocket" || p.type === "Ping") return;
        page.inflightIds.add(p.requestId);
      },
      sessionId,
    );
    const settle = (p: { requestId?: string }): void => {
      if (p?.requestId) page.inflightIds.delete(p.requestId);
      page.lastSettled = Date.now();
    };
    conn.on("Network.loadingFinished", settle, sessionId);
    conn.on("Network.loadingFailed", settle, sessionId);
    conn.on("Network.requestServedFromCache", settle, sessionId);
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Runtime.enable", {}, sessionId);
    await conn.send(
      "Network.enable",
      { maxTotalBufferSize: 128 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024 },
      sessionId,
    );
    return page;
  }

  url(): string {
    return this._url;
  }

  async title(): Promise<string> {
    return (await this.evaluate("document.title")) as string;
  }

  /** Runtime.evaluate an expression; throws on in-page exceptions. */
  async evaluate(expression: string): Promise<unknown> {
    const r = await this.conn.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page evaluate failed: ${d.exception?.description ?? d.text ?? "unknown"}`);
    }
    return r.result?.value;
  }

  async content(): Promise<string> {
    return (await this.evaluate(
      "document.documentElement ? document.documentElement.outerHTML : \"\"",
    )) as string;
  }

  /**
   * Navigate and wait for load/domcontentloaded. A wait timeout resolves
   * (proceed-anyway, like the python harness); a navigation error throws.
   */
  async goto(url: string, opts: GotoOpts = {}): Promise<void> {
    const timeout = opts.timeout ?? 45000;
    this.loadFired = false;
    this.domContentFired = false;
    const r = await this.conn.send<{ errorText?: string }>(
      "Page.navigate",
      { url },
      this.sessionId,
    );
    if (r.errorText) throw new Error(`goto ${url}: ${r.errorText}`);
    this._url = url;
    const fired = (): boolean =>
      opts.waitUntil === "domcontentloaded" ? this.domContentFired || this.loadFired : this.loadFired;
    const deadline = Date.now() + timeout;
    while (!fired() && Date.now() < deadline) {
      await this.waitForTimeout(50);
    }
  }

  /** Approximate networkidle: no in-flight requests for 500ms. Never throws. */
  async waitForLoadState(state: "networkidle" | "load", opts: { timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.timeout ?? 45000);
    if (state === "load") {
      while (!this.loadFired && Date.now() < deadline) await this.waitForTimeout(50);
      return;
    }
    while (Date.now() < deadline) {
      if (this.inflightIds.size === 0 && Date.now() - this.lastSettled >= 500) return;
      await this.waitForTimeout(100);
    }
  }

  waitForTimeout(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async screenshot(opts: { path: string; fullPage?: boolean }): Promise<void> {
    const r = await this.conn.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: opts.fullPage !== false },
      this.sessionId,
    );
    mkdirSync(dirname(opts.path), { recursive: true });
    writeFileSync(opts.path, new Uint8Array(Buffer.from(r.data, "base64")));
  }
}
