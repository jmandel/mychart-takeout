import { describe, expect, test } from "bun:test";
import { classifyOutcome, parseCsrfToken } from "@mychart/core";
import { unzipSync } from "../../../packages/browser/src/zip";
import { derivePrefix } from "../../../packages/browser/src/client";
import { ZipSink } from "../../../packages/browser/src/zipSink";
import { CSRF_TOKEN, LOGIN_PAGE_TOKEN, STALE_PAGE_TOKEN } from "../src/data";
import { startMockMyChart, type MockServer } from "../src/server";

describe("ZipSink", () => {
  test("round-trips text and bytes through a real zip", async () => {
    const sink = new ZipSink();
    await sink.saveText("a/b.json", `{"x":1}`);
    await sink.saveBytes("c.bin", new Uint8Array([1, 2, 3]));
    const files = unzipSync(sink.finalize());
    expect(new TextDecoder().decode(files["a/b.json"]!)).toBe(`{"x":1}`);
    expect([...files["c.bin"]!]).toEqual([1, 2, 3]);
  });
});

describe("derivePrefix", () => {
  test.each([
    ["/MyChart/Home", "/MyChart"],
    ["/MyChart-PRD/app/test-results", "/MyChart-PRD"],
    ["/mychart/inside.asp", "/mychart"],
    ["/", "/MyChart"],
    ["", "/MyChart"],
  ])("%s → %s", (pathname, expected) => {
    expect(derivePrefix(pathname)).toBe(expected);
  });
});

describe("mock server", () => {
  test("serves CSRF page, enforces token on api POSTs, honors prefix", async () => {
    const mock = startMockMyChart({ prefix: "/MyChart-PRD" });
    try {
      const csrf = await fetch(`${mock.url}/MyChart-PRD/Home/CSRFToken`);
      expect(await csrf.text()).toContain("__RequestVerificationToken");

      const noTok = await fetch(`${mock.url}/MyChart-PRD/api/allergies/LoadAllergies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(noTok.status).toBe(403);

      const ok = await fetch(`${mock.url}/MyChart-PRD/api/allergies/LoadAllergies`, {
        method: "POST",
        headers: { "content-type": "application/json", __RequestVerificationToken: "t" },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      const outside = await fetch(`${mock.url}/MyChart/Home`);
      expect(outside.status).toBe(404);
    } finally {
      mock.stop();
    }
  });
});

/**
 * The mock's impersonations of the hostile production instances. These are
 * tests OF THE MOCK: they pin the server behaviors that the detection
 * acceptance suite (detection-acceptance.test.ts) leans on, so a broken
 * impersonation can't silently make an acceptance test pass.
 */
describe("hostile instance variants", () => {
  /** Run `fn` against a fresh mock and always stop it. */
  const withMock = async (
    opts: Parameters<typeof startMockMyChart>[0],
    fn: (mock: MockServer) => Promise<void>,
  ): Promise<void> => {
    const mock = startMockMyChart(opts);
    try {
      await fn(mock);
    } finally {
      mock.stop();
    }
  };

  const apiPost = (mock: MockServer, path: string, token: string | null, prefix = mock.prefix) =>
    fetch(`${mock.url}${prefix}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { __RequestVerificationToken: token }),
      },
      body: "{}",
    });

  test("login-token trap: signed out, /Home/CSRFToken lands on a ~100KB login page carrying a token", () =>
    withMock({ signedIn: false }, async (mock) => {
      const manual = await fetch(`${mock.url}/MyChart/Home/CSRFToken`, { redirect: "manual" });
      expect(manual.status).toBe(302);
      expect(manual.headers.get("location")).toBe(
        "/MyChart/Authentication/Login?postloginurl=%2FMyChart%2FHome%2FCSRFToken",
      );

      const r = await fetch(`${mock.url}/MyChart/Home/CSRFToken`);
      expect(r.status).toBe(200);
      expect(r.url).toContain("/MyChart/Authentication/Login");
      const body = await r.text();
      expect(body.length).toBeGreaterThan(60_000); // a real login page is ~100KB
      expect(body).toContain('type="password"'); // it IS a login form
      // The trap: the generic CSRF parser happily pulls a token out of it.
      expect(parseCsrfToken(body)).toBe(LOGIN_PAGE_TOKEN);
      expect(mock.stats().loginPagesServed).toBeGreaterThan(0);
    }));

  test("signed out: every route bounces, and api POSTs are still counted", () =>
    withMock({ signedIn: false }, async (mock) => {
      for (const path of ["Home", "Visits", "app/test-results"]) {
        const r = await fetch(`${mock.url}/MyChart/${path}`);
        expect(r.url).toContain("/Authentication/Login");
      }
      const r = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN);
      expect(r.url).toContain("/Authentication/Login");
      expect(mock.stats().apiPosts).toBe(1);
    }));

  test("the login page's token authenticates nothing, even on a live session", () =>
    withMock({}, async (mock) => {
      const trapped = await apiPost(mock, "api/allergies/LoadAllergies", LOGIN_PAGE_TOKEN);
      expect(trapped.url).toContain("/Authentication/Login");
      expect(trapped.headers.get("content-type")).toContain("text/html");
      expect(mock.stats().badTokenApiPosts).toBe(1);

      // …and the session survives it (no anti-CSRF kill on this instance).
      const ok = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { dataList: unknown[] }).dataList).toHaveLength(2);
      expect(mock.stats().sessionAlive).toBe(true);
    }));

  test("PX build: no token from /Home/CSRFToken, token + PX markers in the page", () =>
    withMock({ px: true }, async (mock) => {
      // Signed IN, and the token endpoint still bounces to login.
      const csrf = await fetch(`${mock.url}/MyChart/Home/CSRFToken`);
      expect(csrf.url).toContain("/Authentication/Login");

      const home = await fetch(`${mock.url}/MyChart/Home`);
      expect(home.status).toBe(200);
      const page = await home.text();
      expect(parseCsrfToken(page)).toBe(CSRF_TOKEN);
      expect(page).toContain("EpicPx");
      expect(page).toContain("webpackChunk_epic_px_sdk");

      const ok = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN);
      expect(ok.status).toBe(200);
      const invented = await apiPost(mock, "api/allergies/LoadAllergies", "invented-token");
      expect(invented.status).toBe(403);
    }));

  test("prefix alias: 2 redirect hops, including a case change, reach the real app", () =>
    withMock({ prefix: "/MyChartPRD", aliasPrefix: "/MyChart" }, async (mock) => {
      const hops: string[] = [];
      let loc = "/MyChart/Home";
      for (let i = 0; i < 5; i++) {
        const r = await fetch(mock.url + loc, { redirect: "manual" });
        if (r.status !== 302) break;
        loc = r.headers.get("location")!;
        hops.push(loc);
      }
      expect(hops).toEqual(["/mychartprd/Home", "/MyChartPRD/Home"]);

      const final = await fetch(`${mock.url}/MyChart/Home`);
      expect(final.url).toContain("/MyChartPRD/Home");
      expect(await final.text()).toContain("mock-section");
    }));

  test("prefix alias is a trap for POSTs: 302 downgrades them to GETs (SPA shell, no JSON)", () =>
    withMock({ prefix: "/MyChartPRD", aliasPrefix: "/MyChart" }, async (mock) => {
      const r = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN, "/MyChart");
      expect(r.status).toBe(200);
      expect(r.url).toContain("/MyChartPRD/api/allergies/LoadAllergies");
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("app-shell");
      // It never arrived as a POST at all — an alias "works" and returns nothing.
      expect(mock.stats().apiPosts).toBe(0);
    }));

  test("anti-CSRF: one wrong-token api POST kills the session for everyone", () =>
    withMock({ px: true, killOnCsrfMismatch: true, stalePageToken: true }, async (mock) => {
      const before = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN);
      expect(before.status).toBe(200);

      const bad = await apiPost(mock, "api/allergies/LoadAllergies", STALE_PAGE_TOKEN);
      expect(bad.url).toContain("/Authentication/Login");
      expect(mock.stats().sessionAlive).toBe(false);
      expect(mock.stats().killedBy).toBe("api/allergies/LoadAllergies");

      // Now the RIGHT token bounces too, and so does the app's own page load —
      // this is the "MyChart automatically signed you out" the field user saw.
      const after = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN);
      expect(after.url).toContain("/Authentication/Login");
      const home = await fetch(`${mock.url}/MyChart/Home`);
      expect(home.url).toContain("/Authentication/Login");

      const stats = mock.stats();
      expect(stats.apiPosts).toBe(3);
      expect(stats.badTokenApiPosts).toBe(1);
      expect(stats.apiPostPaths).toEqual(Array(3).fill("/MyChart/api/allergies/LoadAllergies"));
    }));

  test("a missing token kills the session too (Epic treats it as forged)", () =>
    withMock({ killOnCsrfMismatch: true }, async (mock) => {
      const r = await apiPost(mock, "api/allergies/LoadAllergies", null);
      expect(r.url).toContain("/Authentication/Login");
      expect(mock.stats().sessionAlive).toBe(false);
    }));

  test("stale page token: the FIRST token in the page markup is the wrong one", () =>
    withMock({ px: true, stalePageToken: true }, async (mock) => {
      const page = await (await fetch(`${mock.url}/MyChart/Home`)).text();
      expect(parseCsrfToken(page)).toBe(STALE_PAGE_TOKEN); // first match = decoy
      expect(page).toContain(CSRF_TOKEN); // the live one is there too, later
      const bad = await apiPost(mock, "api/allergies/LoadAllergies", STALE_PAGE_TOKEN);
      expect(bad.status).toBe(403);
    }));

  test("WAF challenge: api calls answer with an interstitial, NOT a login page", () =>
    withMock({ wafChallenge: true }, async (mock) => {
      const r = await apiPost(mock, "api/allergies/LoadAllergies", CSRF_TOKEN);
      expect(r.status).toBe(200);
      expect(r.url).not.toContain("Authentication/Login");
      const body = await r.text();
      expect(body).toContain("challenge-running");
      expect(body).not.toContain('type="password"');

      // Today's classifier has no "waf-challenge" class; what matters is that
      // it neither claims success nor blames the session.
      const outcome = classifyOutcome({
        status: r.status,
        url: r.url,
        contentType: r.headers.get("content-type"),
        body,
      });
      expect(outcome).not.toBe("ok");
      expect(outcome).not.toBe("redirect-login");

      // The rest of the app still works — only the API is behind the challenge.
      const home = await fetch(`${mock.url}/MyChart/Home`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("mock-section");
    }));

  test("signOut()/signIn(): a live tab's session can die under it", () =>
    withMock({ px: true }, async (mock) => {
      expect((await fetch(`${mock.url}/MyChart/Home`)).status).toBe(200);
      mock.signOut("test");
      const dead = await fetch(`${mock.url}/MyChart/Home`);
      expect(dead.url).toContain("/Authentication/Login");
      mock.signIn();
      const back = await fetch(`${mock.url}/MyChart/Home`);
      expect(back.url).toContain("/MyChart/Home");
    }));
});
