import { describe, expect, test } from "bun:test";
import { makeRunHealth, Mc, parseCsrfToken } from "../src/mc";
import type { FetchInit, McResponse, MyChartClient } from "../src/types";

describe("parseCsrfToken", () => {
  test("hidden input (older Epic)", () => {
    expect(parseCsrfToken('<input name="__RequestVerificationToken" value="tok-abc123" />')).toBe("tok-abc123");
  });
  test("bare token body (some newer builds)", () => {
    expect(parseCsrfToken("  aB3-_x9YZ0123456789  ")).toBe("aB3-_x9YZ0123456789");
  });
  test("empty / html / json → null", () => {
    expect(parseCsrfToken("")).toBeNull();
    expect(parseCsrfToken("<html><body>nope</body></html>")).toBeNull();
    expect(parseCsrfToken('{"a":1}')).toBeNull();
  });
});

describe("Mc logout signal", () => {
  test("trips the abort signal when a call bounces to login", async () => {
    const signal = { aborted: false, reason: "" };
    const client: MyChartClient = {
      origin: "https://h",
      prefix: "/MyChart",
      async fetchText(url: string): Promise<McResponse> {
        if (url.endsWith("/Home/CSRFToken")) {
          return { status: 200, contentType: "text/html", url, body: '<input name="__RequestVerificationToken" value="t"/>' };
        }
        // The API call is answered by the login page (session died).
        return { status: 200, contentType: "text/html", url: "https://h/MyChart/Authentication/Login", body: "<html>login</html>" };
      },
      async fetchBytes() {
        return { status: 200, bytes: new Uint8Array() };
      },
    };
    const mc = new Mc(client, signal);
    await mc.api("api/allergies/LoadAllergies", {});
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("api/allergies/LoadAllergies");
  });
});

describe("Mc rewrite-login rejection", () => {
  test("a login page served at the CSRFToken URL (200, no redirect) yields no token", async () => {
    const LOGIN_PAGE =
      '<html><body><form action="Login"><input name="__RequestVerificationToken" value="trap"/>' +
      '<input name="Login"/><input name="Password" type="password"/></form></body></html>';
    const client: MyChartClient = {
      origin: "https://h",
      prefix: "/MyChart",
      // Rewrite, not redirect: url stays the CSRFToken url, body is the login page.
      async fetchText(url: string): Promise<McResponse> {
        return { status: 200, contentType: "text/html", url, body: LOGIN_PAGE };
      },
      async fetchBytes() {
        return { status: 200, bytes: new Uint8Array() };
      },
    };
    const mc = new Mc(client);
    expect(await mc.token()).toBeNull();
  });
});

describe("Mc token fallback (newer Epic / PX)", () => {
  test("uses getPageToken when /Home/CSRFToken returns no token", async () => {
    let pageTokenReads = 0;
    const client: MyChartClient = {
      origin: "https://mychart.bilh.org",
      prefix: "/MyChart-BILH",
      async fetchText(url: string): Promise<McResponse> {
        // PX build: CSRFToken endpoint 200 but empty (no parseable token)
        if (url.endsWith("/Home/CSRFToken")) return { status: 200, contentType: null, url, body: "" };
        return { status: 200, contentType: "application/json", url, body: "{}" };
      },
      async fetchBytes() {
        return { status: 200, bytes: new Uint8Array() };
      },
      async getPageToken() {
        pageTokenReads++;
        return "page-embedded-token";
      },
    };
    const mc = new Mc(client);
    expect(await mc.token()).toBe("page-embedded-token");
    expect(pageTokenReads).toBe(1);
  });
});

/** Records every request; serves a CSRF page and echoes call shape as JSON. */
class FakeClient implements MyChartClient {
  readonly origin = "https://mychart.example.org";
  readonly prefix = "/MyChart";
  calls: { url: string; init: FetchInit }[] = [];
  tokenServed = 0;

  async fetchText(pathOrUrl: string, init: FetchInit = {}): Promise<McResponse> {
    this.calls.push({ url: pathOrUrl, init });
    if (pathOrUrl.endsWith("/Home/CSRFToken")) {
      this.tokenServed++;
      return this.resp(
        `<input name="__RequestVerificationToken" type="hidden" value="tok-abc123" />`,
      );
    }
    return this.resp(JSON.stringify({ ok: true, method: init.method ?? "GET" }));
  }

  async fetchBytes(): Promise<{ status: number; bytes: Uint8Array }> {
    return { status: 200, bytes: new Uint8Array() };
  }

  private resp(body: string): McResponse {
    return { status: 200, contentType: "text/html", url: "x", body };
  }
}

describe("Mc wrapper", () => {
  test("fetches + caches CSRF token, prefixes relative paths", async () => {
    const c = new FakeClient();
    const mc = new Mc(c);
    const r1 = await mc.api("api/allergies/LoadAllergies", { isHealthSummary: false });
    const r2 = await mc.get("api/letters/GetLettersList");
    expect(c.tokenServed).toBe(1); // cached after first call
    expect(r1.json).toEqual({ ok: true, method: "POST" });
    expect(r2.json).toEqual({ ok: true, method: "GET" });
    const apiCall = c.calls.find((x) => x.url === "/MyChart/api/allergies/LoadAllergies");
    expect(apiCall).toBeDefined();
    expect(apiCall!.init.headers?.__RequestVerificationToken).toBe("tok-abc123");
    expect(apiCall!.init.headers?.["Content-Type"]).toBe("application/json");
    expect(apiCall!.init.body).toBe(JSON.stringify({ isHealthSummary: false }));
  });

  test("form posts urlencoded; nobody posts without body/content-type", async () => {
    const c = new FakeClient();
    const mc = new Mc(c);
    await mc.form("HealthAdvisories/GetTopics", "registryID=");
    await mc.nobody("Clinical/CovidStatus/LoadCovidStatus");
    const form = c.calls.find((x) => x.url.endsWith("GetTopics"))!;
    expect(form.init.headers?.["Content-Type"]).toContain("x-www-form-urlencoded");
    expect(form.init.body).toBe("registryID=");
    const nb = c.calls.find((x) => x.url.endsWith("LoadCovidStatus"))!;
    expect(nb.init.method).toBe("POST");
    expect(nb.init.body).toBeUndefined();
    expect(nb.init.headers?.["Content-Type"]).toBeUndefined();
  });

  test("query-string paths pass through intact (care-team nobody variant)", async () => {
    const c = new FakeClient();
    const mc = new Mc(c);
    await mc.nobody("Clinical/CareTeam/Load?hfrId=&sources=&actions=&isPrimaryStandalone=true&ComponentNumber=2");
    expect(
      c.calls.some((x) =>
        x.url === "/MyChart/Clinical/CareTeam/Load?hfrId=&sources=&actions=&isPrimaryStandalone=true&ComponentNumber=2",
      ),
    ).toBe(true);
  });

  test("token refresh refetches", async () => {
    const c = new FakeClient();
    const mc = new Mc(c);
    await mc.token();
    await mc.token(true);
    expect(c.tokenServed).toBe(2);
  });

  test("initialToken seeds the cache — no unverified CSRFToken refetch", async () => {
    const c = new FakeClient();
    const mc = new Mc(c, undefined, { initialToken: "verified-tok" });
    await mc.api("api/allergies/LoadAllergies", {});
    expect(c.tokenServed).toBe(0);
    const call = c.calls.find((x) => x.url.endsWith("LoadAllergies"))!;
    expect(call.init.headers?.__RequestVerificationToken).toBe("verified-tok");
  });
});

/** Scriptable client: per-path behavior for breaker/timeout tests. */
class FlakyClient implements MyChartClient {
  readonly origin = "https://mychart.example.org";
  readonly prefix = "/MyChart";
  calls: string[] = [];
  /** api behavior: "throw-timeout" | "throw-network" | "500" | "ok" (in order, last repeats) */
  constructor(
    private script: string[],
    private probeAlive: boolean,
  ) {}

  private n = 0;
  async fetchText(pathOrUrl: string, init: FetchInit = {}): Promise<McResponse> {
    this.calls.push(`${init.method ?? "GET"} ${pathOrUrl}${init.timeoutMs ? ` t=${init.timeoutMs}` : ""}`);
    const mk = (status: number, body: string, url = pathOrUrl): McResponse => ({
      status, contentType: "application/json", url, body,
    });
    if (pathOrUrl.endsWith("/Home/CSRFToken")) {
      return { status: 200, contentType: "text/html", url: pathOrUrl, body: '<input name="__RequestVerificationToken" value="t"/>' };
    }
    if (pathOrUrl.endsWith("/Home")) {
      if (!this.probeAlive) throw new Error("timeout after 8000ms: /MyChart/Home");
      return { status: 200, contentType: "text/html", url: pathOrUrl, body: "<html>app</html>" };
    }
    const step = this.script[Math.min(this.n++, this.script.length - 1)]!;
    if (step === "throw-timeout") throw new Error(`timeout after ${init.timeoutMs}ms: ${pathOrUrl}`);
    if (step === "throw-network") throw new Error(`network-error: ${pathOrUrl}`);
    if (step === "500") return mk(500, "oops");
    return mk(200, '{"ok":true}');
  }
  async fetchBytes(): Promise<{ status: number; bytes: Uint8Array }> {
    return { status: 200, bytes: new Uint8Array() };
  }
}

describe("Mc resilience", () => {
  test("retries once (cheaper timeout) when the world was healthy, then succeeds", async () => {
    const c = new FlakyClient(["throw-timeout", "ok"], true);
    const mc = new Mc(c, { aborted: false, reason: "" });
    const r = await mc.api("api/allergies/LoadAllergies", {});
    expect(r.json).toEqual({ ok: true });
    const apiCalls = c.calls.filter((x) => x.includes("LoadAllergies"));
    expect(apiCalls.length).toBe(2);
    expect(apiCalls[1]).toContain("t=10000"); // retry used the reduced budget
  });

  test("no retry once other failures are recent; breaker trips when probe fails too", async () => {
    const signal = { aborted: false, reason: "" };
    const c = new FlakyClient(["throw-timeout"], false); // everything times out, probe dead
    const mc = new Mc(c, signal);
    // call 1: attempt + retry both fail (2 consecutive) — no trip yet (< 3)
    await expect(mc.api("api/one/One", {})).rejects.toThrow(/timeout/);
    expect(signal.aborted).toBe(false);
    // call 2: 3rd consecutive failure → probe /Home → dead → circuit opens
    await expect(mc.api("api/two/Two", {})).rejects.toThrow(/timeout/);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toContain("circuit-open");
    // call 3: skipped without any network I/O
    const before = c.calls.length;
    await expect(mc.api("api/three/Three", {})).rejects.toThrow(/skipped \(circuit-open/);
    expect(c.calls.length).toBe(before);
  });

  test("a live probe defers tripping, but 8 consecutive failures trip regardless", async () => {
    const signal = { aborted: false, reason: "" };
    const c = new FlakyClient(["throw-network"], true); // endpoints dead, probe alive
    const mc = new Mc(c, signal);
    const failures: number[] = [];
    for (let i = 0; i < 10 && !signal.aborted; i++) {
      await mc.api(`api/e${i}/E`, {}).catch(() => failures.push(i));
    }
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toContain("circuit-open: 8 consecutive failures");
  });

  test("5xx responses return normally but feed the breaker", async () => {
    const signal = { aborted: false, reason: "" };
    const c = new FlakyClient(["500"], false);
    const mc = new Mc(c, signal);
    const r1 = await mc.api("api/a/A", {}); // 500 #1 (no retry for returned 5xx)
    expect(r1.status).toBe(500);
    await mc.api("api/b/B", {}); // #2
    await mc.api("api/c/C", {}); // #3 → probe (dead) → trip
    expect(signal.aborted).toBe(true);
    await expect(mc.api("api/d/D", {})).rejects.toThrow(/skipped/);
  });

  test("run deadline stops new calls and records the reason", async () => {
    const signal = { aborted: false, reason: "" };
    const health = makeRunHealth(1); // 1ms budget — already expired
    await new Promise((r) => setTimeout(r, 5));
    const c = new FlakyClient(["ok"], true);
    const mc = new Mc(c, signal, { health });
    await expect(mc.api("api/a/A", {})).rejects.toThrow(/skipped \(run-deadline\)/);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("run-deadline");
  });

  test("success resets the failure streak", async () => {
    const signal = { aborted: false, reason: "" };
    const c = new FlakyClient(["throw-network", "throw-network", "ok", "throw-network", "throw-network", "ok"], false);
    const mc = new Mc(c, signal);
    await expect(mc.api("api/a/A", {})).rejects.toThrow(); // 2 consecutive (attempt+retry)
    await mc.api("api/b/B", {}); // ok → reset
    await expect(mc.api("api/c/C", {})).rejects.toThrow(); // 2 consecutive again — never reaches 3
    expect(signal.aborted).toBe(false);
  });
});
