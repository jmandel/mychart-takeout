import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CdpEvents } from "./rawcdp";

/**
 * Network logger — port of harness/mychart.py Session network capture.
 * Appends one JSON line per response to <out>/raw_network/responses.jsonl and
 * persists text-like/pdf bodies under <out>/raw_network/bodies/.
 *
 * Wired to raw CDP Network.* events on the attached page session only (the
 * python attached to every page in the context; here other tabs are not
 * logged — the export drives a single tab anyway).
 */

// content types we persist bodies for
const SAVE_CT = [
  "json", "xml", "html", "text/plain", "pdf", "fhir", "csv",
  "javascript", "octet-stream", "hl7", "ccda",
];
const SKIP_CT = ["image/", "font/", "text/css", "video/", "audio/", "wasm"];
export const MAX_BODY = 40 * 1024 * 1024;

const EXT: Record<string, string> = {
  "application/json": "json", "text/json": "json",
  "application/xml": "xml", "text/xml": "xml",
  "text/html": "html", "application/xhtml+xml": "html",
  "text/plain": "txt", "application/pdf": "pdf", "text/csv": "csv",
  "application/javascript": "js", "text/javascript": "js",
};

/** Port of mychart.py _ext_for. */
export function extFor(ct: string | null, url: string | null): string {
  const c = (ct ?? "").split(";")[0]!.trim().toLowerCase();
  if (c in EXT) return EXT[c]!;
  if (c.includes("json") || c.includes("fhir+json")) return "json";
  if (c.includes("xml")) return "xml";
  if (c.includes("html")) return "html";
  if (c.includes("pdf")) return "pdf";
  const m = /\.(json|xml|html|pdf|csv|txt|xhtml)(\?|$)/.exec(url ?? "");
  return m ? m[1]! : "bin";
}

/** Port of mychart.py _should_save. */
export function shouldSave(ct: string | null, url: string | null): boolean {
  const c = (ct ?? "").toLowerCase();
  if (SKIP_CT.some((s) => c.includes(s))) return false;
  if (SAVE_CT.some((s) => c.includes(s))) return true;
  if (c === "" && /(FHIR|api|Async|Get|Load|Data|json|xml|pdf)/i.test(url ?? "")) return true;
  return false;
}

/** One finished response, transport-free (unit-testable core). */
export interface ResponseInfo {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  contentType: string;
  postData: string | null;
  /** Fetch the body when eligible; null/throw when unavailable. */
  body: () => Promise<Uint8Array | null>;
}

interface PendingReq {
  method: string;
  url: string;
  resourceType: string;
  postData: string | null;
  hasPostData: boolean;
  status?: number;
  contentType?: string;
}

export class NetLogger {
  private seq = 0;
  readonly netDir: string;
  readonly bodiesDir: string;
  readonly logFile: string;
  readonly captureBodies: boolean;
  private reqs = new Map<string, PendingReq>();

  constructor(outDir: string, opts: { captureBodies?: boolean } = {}) {
    this.netDir = join(outDir, "raw_network");
    this.bodiesDir = join(this.netDir, "bodies");
    this.logFile = join(this.netDir, "responses.jsonl");
    this.captureBodies =
      (opts.captureBodies ?? true) && process.env.MYCHART_NO_BODIES !== "1";
    mkdirSync(this.bodiesDir, { recursive: true });
  }

  /** Subscribe to Network.* events on a flat CDP session. */
  attachCdp(conn: CdpEvents, sessionId: string): void {
    conn.on(
      "Network.requestWillBeSent",
      (e: {
        requestId: string;
        type?: string;
        request: { method: string; url: string; postData?: string; hasPostData?: boolean };
      }) => {
        this.reqs.set(e.requestId, {
          method: e.request.method,
          url: e.request.url,
          resourceType: (e.type ?? "").toLowerCase(),
          postData: e.request.postData ?? null,
          hasPostData: !!e.request.hasPostData,
        });
      },
      sessionId,
    );
    conn.on(
      "Network.responseReceived",
      (e: { requestId: string; response: { status: number; headers: Record<string, string>; mimeType?: string } }) => {
        const r = this.reqs.get(e.requestId);
        if (!r) return;
        r.status = e.response.status;
        const hk = Object.keys(e.response.headers).find((k) => k.toLowerCase() === "content-type");
        r.contentType = (hk ? e.response.headers[hk] : undefined) ?? e.response.mimeType ?? "";
      },
      sessionId,
    );
    conn.on(
      "Network.loadingFinished",
      (e: { requestId: string }) => {
        const r = this.reqs.get(e.requestId);
        if (!r) return;
        this.reqs.delete(e.requestId);
        void this.finalize(conn, sessionId, e.requestId, r);
      },
      sessionId,
    );
    conn.on(
      "Network.loadingFailed",
      (e: { requestId: string; errorText?: string }) => {
        const r = this.reqs.get(e.requestId);
        if (!r) return;
        this.reqs.delete(e.requestId);
        this.logFailed({
          method: r.method,
          url: r.url,
          resourceType: r.resourceType,
          failure: e.errorText ?? "",
        });
      },
      sessionId,
    );
  }

  private async finalize(
    conn: CdpEvents,
    sessionId: string,
    requestId: string,
    r: PendingReq,
  ): Promise<void> {
    let postData = r.postData;
    if (!postData && r.hasPostData && ["POST", "PUT", "PATCH"].includes(r.method)) {
      try {
        const pd = await conn.send<{ postData: string }>(
          "Network.getRequestPostData",
          { requestId },
          sessionId,
        );
        postData = pd.postData;
      } catch {
        /* ignore */
      }
    }
    await this.logResponse({
      method: r.method,
      url: r.url,
      status: r.status ?? 0,
      resourceType: r.resourceType,
      contentType: r.contentType ?? "",
      postData,
      body: async () => {
        const b = await conn.send<{ body: string; base64Encoded: boolean }>(
          "Network.getResponseBody",
          { requestId },
          sessionId,
        );
        return b.base64Encoded
          ? new Uint8Array(Buffer.from(b.body, "base64"))
          : new TextEncoder().encode(b.body);
      },
    });
  }

  /** Log entries for responses whose loadingFinished never arrived (no body). */
  flush(): void {
    for (const r of this.reqs.values()) {
      if (r.status === undefined) continue;
      void this.logResponse({
        method: r.method,
        url: r.url,
        status: r.status,
        resourceType: r.resourceType,
        contentType: r.contentType ?? "",
        postData: r.postData,
        body: async () => null,
      });
    }
    this.reqs.clear();
  }

  private append(entry: unknown): void {
    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
    } catch {
      /* swallow, matches python */
    }
  }

  async logResponse(info: ResponseInfo): Promise<void> {
    try {
      let bodyFile: string | null = null;
      let bodySize: number | null = null;
      if (this.captureBodies && shouldSave(info.contentType, info.url) && info.method !== "OPTIONS") {
        try {
          const body = await info.body();
          if (body) {
            bodySize = body.length;
            if (body.length > 0 && body.length <= MAX_BODY) {
              const ext = extFor(info.contentType, info.url);
              const h = createHash("sha1")
                .update(info.url + String(this.seq))
                .digest("hex")
                .slice(0, 12);
              this.seq += 1;
              const fname = `${h}.${ext}`;
              writeFileSync(join(this.bodiesDir, fname), body);
              bodyFile = `bodies/${fname}`;
            }
          }
        } catch {
          /* navigation race purged the buffer — swallow per entry, matches python */
        }
      }
      const entry: Record<string, unknown> = {
        ts: Date.now() / 1000,
        event: "response",
        method: info.method,
        url: info.url,
        status: info.status,
        resource_type: info.resourceType,
        content_type: info.contentType,
        body_file: bodyFile,
        body_size: bodySize,
      };
      if (info.postData && ["POST", "PUT", "PATCH"].includes(info.method)) {
        entry.post_data = info.postData.slice(0, 4000);
      }
      this.append(entry);
    } catch {
      /* swallow, matches python */
    }
  }

  logFailed(info: { method: string; url: string; resourceType: string; failure: string }): void {
    try {
      this.append({
        ts: Date.now() / 1000,
        event: "requestfailed",
        method: info.method,
        url: info.url,
        resource_type: info.resourceType,
        failure: info.failure,
      });
    } catch {
      /* ignore */
    }
  }
}
