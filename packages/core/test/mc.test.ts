import { describe, expect, test } from "bun:test";
import { Mc, parseCsrfToken } from "../src/mc";
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
});
