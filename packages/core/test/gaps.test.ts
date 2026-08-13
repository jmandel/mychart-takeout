import { describe, expect, test } from "bun:test";
import { classifyOutcome, renderGapsMd, summarizeGaps } from "../src/gaps";
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
});
