import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extFor,
  MAX_BODY,
  NetLogger,
  shouldSave,
  type ResponseInfo,
} from "../src/netlog";
import type { CdpEvents } from "../src/rawcdp";

describe("shouldSave (port of _should_save)", () => {
  test("saves data content types", () => {
    expect(shouldSave("application/json", "x")).toBe(true);
    expect(shouldSave("text/xml; charset=utf-8", "x")).toBe(true);
    expect(shouldSave("text/html", "x")).toBe(true);
    expect(shouldSave("application/pdf", "x")).toBe(true);
    expect(shouldSave("text/csv", "x")).toBe(true);
    expect(shouldSave("application/javascript", "x")).toBe(true);
    expect(shouldSave("application/fhir+json", "x")).toBe(true);
  });
  test("skips media", () => {
    expect(shouldSave("image/png", "x")).toBe(false);
    expect(shouldSave("font/woff2", "x")).toBe(false);
    expect(shouldSave("text/css", "x")).toBe(false);
    expect(shouldSave("video/mp4", "x")).toBe(false);
  });
  test("empty content type saved only when URL looks data-ish", () => {
    expect(shouldSave("", "https://h/MyChart/api/foo/Load")).toBe(true);
    expect(shouldSave("", "https://h/static/thing.woff")).toBe(false);
    expect(shouldSave(null, "https://h/GetData")).toBe(true);
  });
});

describe("extFor (port of _ext_for)", () => {
  test("direct map + fuzzy + url fallback", () => {
    expect(extFor("application/json", "x")).toBe("json");
    expect(extFor("text/html; charset=utf-8", "x")).toBe("html");
    expect(extFor("application/fhir+json", "x")).toBe("json");
    expect(extFor("application/xml", "x")).toBe("xml");
    expect(extFor("application/pdf", "x")).toBe("pdf");
    expect(extFor("", "https://h/report.pdf")).toBe("pdf");
    expect(extFor("", "https://h/data.json?x=1")).toBe("json");
    expect(extFor("", "https://h/whatever")).toBe("bin");
    expect(extFor("application/octet-stream", "https://h/x")).toBe("bin");
  });
});

// ---- helpers ---------------------------------------------------------------
function info(opts: {
  url: string;
  status?: number;
  method?: string;
  ct?: string;
  body?: Uint8Array | null;
  bodyThrows?: boolean;
  post?: string | null;
}): ResponseInfo {
  return {
    method: opts.method ?? "GET",
    url: opts.url,
    status: opts.status ?? 200,
    resourceType: "xhr",
    contentType: opts.ct ?? "",
    postData: opts.post ?? null,
    body: async () => {
      if (opts.bodyThrows) throw new Error("navigation race purged buffer");
      return opts.body ?? new Uint8Array();
    },
  };
}

function readLog(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, "raw_network", "responses.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("NetLogger.logResponse", () => {
  test("writes body file for json + logs metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    await nl.logResponse(
      info({ url: "https://h/MyChart/api/x/Load", ct: "application/json", body: new TextEncoder().encode('{"a":1}') }),
    );
    const log = readLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]!.body_file).toMatch(/^bodies\/[0-9a-f]{12}\.json$/);
    expect(log[0]!.content_type).toBe("application/json");
    const bodies = readdirSync(join(dir, "raw_network", "bodies"));
    expect(bodies).toHaveLength(1);
  });

  test("skips OPTIONS and images; still logs the line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    await nl.logResponse(info({ url: "https://h/x", ct: "application/json", method: "OPTIONS", body: new Uint8Array([1, 2]) }));
    await nl.logResponse(info({ url: "https://h/logo.png", ct: "image/png", body: new Uint8Array([1, 2]) }));
    const log = readLog(dir);
    expect(log).toHaveLength(2);
    expect(log[0]!.body_file).toBeNull();
    expect(log[1]!.body_file).toBeNull();
    expect(readdirSync(join(dir, "raw_network", "bodies"))).toHaveLength(0);
  });

  test("captureBodies=false logs metadata but writes no bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir, { captureBodies: false });
    await nl.logResponse(info({ url: "https://h/api/Load", ct: "application/json", body: new TextEncoder().encode("{}") }));
    expect(readLog(dir)[0]!.body_file).toBeNull();
    expect(readdirSync(join(dir, "raw_network", "bodies"))).toHaveLength(0);
  });

  test("over-MAX_BODY body is not written but size is recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    const big = { length: MAX_BODY + 1 } as unknown as Uint8Array; // avoid allocating 40MB
    await nl.logResponse(info({ url: "https://h/api/Load", ct: "application/json", body: big }));
    const line = readLog(dir)[0]!;
    expect(line.body_file).toBeNull();
    expect(line.body_size).toBe(MAX_BODY + 1);
  });

  test("body() throwing is swallowed; line still logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    await nl.logResponse(info({ url: "https://h/api/Load", ct: "application/json", bodyThrows: true }));
    const line = readLog(dir)[0]!;
    expect(line.body_file).toBeNull();
    expect(line.event).toBe("response");
  });

  test("truncates POST post_data to 4000 chars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    await nl.logResponse(
      info({ url: "https://h/api/Load", ct: "application/json", method: "POST", post: "x".repeat(5000), body: new TextEncoder().encode("{}") }),
    );
    expect((readLog(dir)[0]!.post_data as string).length).toBe(4000);
  });

  test("requestfailed entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    nl.logFailed({ method: "GET", url: "https://h/x", resourceType: "fetch", failure: "net::ERR_ABORTED" });
    const line = readLog(dir)[0]!;
    expect(line.event).toBe("requestfailed");
    expect(line.failure).toBe("net::ERR_ABORTED");
  });
});

describe("NetLogger.attachCdp event wiring", () => {
  /** Fake CdpEvents bus: capture handlers, let the test emit CDP events. */
  function fakeBus(bodies: Record<string, { body: string; base64Encoded: boolean }>) {
    const handlers = new Map<string, (p: unknown) => void>();
    const bus: CdpEvents = {
      on: (method, handler, sessionId) => {
        handlers.set(`${sessionId}|${method}`, handler as (p: unknown) => void);
      },
      send: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
        if (method === "Network.getResponseBody") {
          const b = bodies[String(params?.requestId)];
          if (!b) throw new Error("No resource with given identifier");
          return b as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const emit = (method: string, params: unknown): void => {
      handlers.get(`s1|${method}`)?.(params);
    };
    return { bus, emit };
  }

  test("request→response→finished produces a body-bearing entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    const { bus, emit } = fakeBus({ r1: { body: '{"a":1}', base64Encoded: false } });
    nl.attachCdp(bus, "s1");
    emit("Network.requestWillBeSent", {
      requestId: "r1",
      type: "XHR",
      request: { method: "POST", url: "https://h/MyChart/api/x/Load", postData: "{}", hasPostData: true },
    });
    emit("Network.responseReceived", {
      requestId: "r1",
      response: { status: 200, headers: { "Content-Type": "application/json" }, mimeType: "application/json" },
    });
    emit("Network.loadingFinished", { requestId: "r1" });
    await Bun.sleep(20); // finalize is async
    const line = readLog(dir)[0]!;
    expect(line.method).toBe("POST");
    expect(line.status).toBe(200);
    expect(line.resource_type).toBe("xhr");
    expect(line.content_type).toBe("application/json");
    expect(line.body_file).toMatch(/^bodies\//);
    expect(line.post_data).toBe("{}");
  });

  test("loadingFailed produces a requestfailed entry; flush drains stragglers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nl-"));
    const nl = new NetLogger(dir);
    const { bus, emit } = fakeBus({});
    nl.attachCdp(bus, "s1");
    emit("Network.requestWillBeSent", {
      requestId: "r1",
      type: "Fetch",
      request: { method: "GET", url: "https://h/a" },
    });
    emit("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_ABORTED" });
    // straggler: response received, loadingFinished never fires
    emit("Network.requestWillBeSent", {
      requestId: "r2",
      type: "XHR",
      request: { method: "GET", url: "https://h/api/Load" },
    });
    emit("Network.responseReceived", {
      requestId: "r2",
      response: { status: 200, headers: { "content-type": "application/json" } },
    });
    nl.flush();
    await Bun.sleep(20);
    const log = readLog(dir);
    expect(log).toHaveLength(2);
    expect(log[0]!.event).toBe("requestfailed");
    expect(log[0]!.failure).toBe("net::ERR_ABORTED");
    expect(log[1]!.event).toBe("response");
    expect(log[1]!.url).toBe("https://h/api/Load");
    expect(log[1]!.body_file).toBeNull(); // no body available post-hoc
  });
});
