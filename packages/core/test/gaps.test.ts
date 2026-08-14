import { describe, expect, test } from "bun:test";
import { classifyError, classifyOutcome, renderGapsMd, summarizeGaps } from "../src/gaps";
import type { ManifestEntry } from "../src/types";

describe("classifyOutcome", () => {
  test("2xx JSON → ok / empty", () => {
    expect(classifyOutcome({ status: 200, json: { a: 1 }, url: "u", contentType: "application/json" })).toBe("ok");
    expect(classifyOutcome({ status: 200, json: {}, url: "u" })).toBe("empty");
    expect(classifyOutcome({ status: 200, json: [], url: "u" })).toBe("empty");
  });
  test("2xx HTML where JSON expected → spa-shell", () => {
    expect(
      classifyOutcome({ status: 200, json: undefined, body: "<!doctype html><html>…", contentType: "text/html" }),
    ).toBe("spa-shell");
  });
  test("login/logout redirect detected by url", () => {
    expect(classifyOutcome({ status: 200, url: "https://h/MyChart/Authentication/Login?action=logout" })).toBe(
      "redirect-login",
    );
  });
  test("http error families", () => {
    expect(classifyOutcome({ status: 403, url: "u" })).toBe("forbidden");
    expect(classifyOutcome({ status: 404, url: "u" })).toBe("not-found");
    expect(classifyOutcome({ status: 500, url: "u" })).toBe("server-error");
    expect(classifyOutcome({ status: null, url: "u" })).toBe("http-error");
  });
  test("WAF block pages → waf-challenge, whatever the status", () => {
    const f5 = "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. " +
      "Please consult with your administrator.<br>Your support ID is: 1234567890</body></html>";
    expect(classifyOutcome({ status: 200, body: f5, contentType: "text/html", url: "u" })).toBe("waf-challenge");
    expect(classifyOutcome({ status: 403, body: f5, contentType: "text/html", url: "u" })).toBe("waf-challenge");
    // login redirect wins over challenge sniffing (checked first by url)
    expect(classifyOutcome({ status: 200, body: f5, url: "https://h/M/Authentication/Login" })).toBe("redirect-login");
    // a plain 403 without challenge markers stays forbidden
    expect(classifyOutcome({ status: 403, body: "<html>Denied</html>", contentType: "text/html", url: "u" })).toBe("forbidden");
  });
});

describe("classifyError", () => {
  test("maps thrown Mc errors to outcomes", () => {
    expect(classifyError(new Error("timeout after 30000ms: api/x"))).toBe("timeout");
    expect(classifyError(new Error("network-error: api/x"))).toBe("network-error");
    expect(classifyError(new Error("skipped (circuit-open: timeout at api/y): api/x"))).toBe("skipped-circuit-open");
    expect(classifyError(new Error("skipped (run-deadline): api/x"))).toBe("skipped-deadline");
    expect(classifyError(new Error("skipped (api/health-summary/FetchHealthSummary): api/x"))).toBe("skipped");
    expect(classifyError(new Error("boom"))).toBe("error");
  });
});

describe("summarizeGaps", () => {
  const manifest: ManifestEntry[] = [
    { domain: "allergies", endpoint: "LoadAllergies", status: 200, bytes: 50, note: "", outcome: "ok" },
    { domain: "documents", endpoint: "LoadOtherDocuments", status: 200, bytes: 2, note: "", outcome: "empty" },
    { domain: "track-my-health", endpoint: "GetExternalAccounts", status: 500, bytes: 2, note: "", outcome: "server-error" },
    { domain: "care-team", endpoint: "Load", status: 200, bytes: 900, note: "shell", outcome: "spa-shell" },
    // a phase roll-up row (no outcome) must not count as an attempt
    { domain: "visits", endpoint: "AVS+notes", status: 200, bytes: 0, note: "25 AVS" },
  ];

  test("counts attempts, ok, empty, and lists concerns (not summary rows)", () => {
    const g = summarizeGaps(manifest);
    expect(g.attempted).toBe(4); // excludes the summary row
    expect(g.ok).toBe(1);
    expect(g.empty).toBe(1);
    expect(g.concerns.map((c) => c.endpoint).sort()).toEqual(["GetExternalAccounts", "Load"]);
    expect(g.emptyEndpoints).toEqual([{ domain: "documents", endpoint: "LoadOtherDocuments" }]);
    expect(g.byOutcome.summary).toBe(1);
  });

  test("renderGapsMd surfaces the concern table + the real-world 500", () => {
    const md = renderGapsMd(summarizeGaps(manifest));
    expect(md).toContain("# Export gaps report");
    expect(md).toContain("**2 need attention**");
    expect(md).toContain("GetExternalAccounts");
    expect(md).toContain("server-error");
  });

  test("clean run reports no concerns", () => {
    const md = renderGapsMd(summarizeGaps([{ domain: "a", endpoint: "b", status: 200, bytes: 9, note: "", outcome: "ok" }]));
    expect(md).toContain("No failed or degraded endpoints. ✅");
  });

  test("skipped rows land in their own bucket, and stoppedEarly is surfaced", () => {
    const g = summarizeGaps(
      [
        { domain: "a", endpoint: "A", status: 200, bytes: 9, note: "", outcome: "ok" },
        { domain: "b", endpoint: "B", status: null, bytes: 0, note: "circuit open", outcome: "skipped-circuit-open" },
        { domain: "c", endpoint: "C", status: null, bytes: 0, note: "", outcome: "skipped" },
      ],
      "circuit-open: timeout at api/b/B",
    );
    expect(g.attempted).toBe(1); // skips are not attempts
    expect(g.skipped.length).toBe(2);
    expect(g.stoppedEarly).toContain("circuit-open");
    const md = renderGapsMd(g);
    expect(md).toContain("**Run stopped early:**");
    expect(md).toContain("## Skipped (2");
  });
});
