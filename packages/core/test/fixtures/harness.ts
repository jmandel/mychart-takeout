/** Test doubles for phase unit tests: FakeClient, MemorySink, ctx. */
import { makeCtx, type PhaseCtx } from "../../src/ctx";
import { isRecord } from "../../src/util";
import type { FetchInit, McResponse, MyChartClient, Sink } from "../../src/types";

export class MemorySink implements Sink {
  files = new Map<string, string | Uint8Array>();
  async saveText(rel: string, text: string): Promise<void> {
    this.files.set(rel, text);
  }
  async saveBytes(rel: string, bytes: Uint8Array): Promise<void> {
    this.files.set(rel, bytes);
  }
  text(rel: string): string {
    const v = this.files.get(rel);
    if (typeof v !== "string") throw new Error(`no text saved at ${rel}`);
    return v;
  }
  json(rel: string): unknown {
    return JSON.parse(this.text(rel));
  }
  bytes(rel: string): Uint8Array {
    const v = this.files.get(rel);
    if (!(v instanceof Uint8Array)) throw new Error(`no bytes saved at ${rel}`);
    return v;
  }
  has(rel: string): boolean {
    return this.files.has(rel);
  }
  keys(prefix = ""): string[] {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

const CSRF_BODY = `<input name="__RequestVerificationToken" type="hidden" value="tok-test" />`;

/** Route value: JSON-serializable object, a raw HTML string (→ non-JSON
 * response, like the SPA shell), or a function of (init, url). */
export type RouteHandler = unknown | ((init: FetchInit, url: string) => unknown);

export class FakeClient implements MyChartClient {
  readonly origin = "https://mychart.example.org";
  readonly prefix = "/MyChart";
  calls: { url: string; init: FetchInit }[] = [];
  bytesCalls: string[] = [];
  bytesRoutes = new Map<string, { status: number; bytes: Uint8Array }>();

  constructor(private routes: Record<string, RouteHandler> = {}) {}

  route(key: string, handler: RouteHandler): this {
    this.routes[key] = handler;
    return this;
  }

  async fetchText(pathOrUrl: string, init: FetchInit = {}): Promise<McResponse> {
    this.calls.push({ url: pathOrUrl, init });
    if (pathOrUrl.endsWith("/Home/CSRFToken")) {
      return resp(200, CSRF_BODY, "text/html", pathOrUrl);
    }
    const key = routeKey(pathOrUrl);
    if (!(key in this.routes)) {
      return resp(404, "<html>SPA shell</html>", "text/html", pathOrUrl);
    }
    const r = this.routes[key];
    const v = typeof r === "function" ? (r as (i: FetchInit, u: string) => unknown)(init, pathOrUrl) : r;
    if (typeof v === "string") return resp(200, v, "text/html", pathOrUrl);
    return resp(200, JSON.stringify(v), "application/json", pathOrUrl);
  }

  async fetchBytes(pathOrUrl: string): Promise<{ status: number; bytes: Uint8Array }> {
    this.bytesCalls.push(pathOrUrl);
    return this.bytesRoutes.get(routeKey(pathOrUrl)) ?? { status: 404, bytes: new Uint8Array() };
  }
}

function routeKey(pathOrUrl: string): string {
  return pathOrUrl.replace(/^\/MyChart\//, "").split("?")[0]!;
}

function resp(status: number, body: string, contentType: string, url: string): McResponse {
  return { status, contentType, url, body };
}

/** Parse a JSON request body posted through Mc.api. */
export function bodyOf(init: FetchInit): Record<string, unknown> {
  try {
    const v = JSON.parse(init.body ?? "");
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

export interface TestCtx {
  ctx: PhaseCtx;
  sink: MemorySink;
  logs: string[];
}

export function makeTestCtx(
  client: FakeClient,
  opts: { nonce?: string; excludeDocIds?: ReadonlySet<string> } = {},
): TestCtx {
  const sink = new MemorySink();
  const logs: string[] = [];
  const ctx = makeCtx({
    client,
    sink,
    nonce: opts.nonce ?? "deadbeef",
    timeZone: "UTC",
    excludeDocIds: opts.excludeDocIds,
    log: (m) => logs.push(m),
  });
  ctx.wait = async () => {}; // instant polling in tests
  return { ctx, sink, logs };
}
