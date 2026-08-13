import { describe, expect, test } from "bun:test";
import { deriveOriginPrefix, pickTarget } from "../src/session";

describe("deriveOriginPrefix", () => {
  const cases: [url: string, origin: string, prefix: string][] = [
    ["https://mychart.example.org/MyChart/Home", "https://mychart.example.org", "/MyChart"],
    ["https://h/MyChart/app/health-summary", "https://h", "/MyChart"],
    ["https://h/MyChart-PRD/app/x", "https://h", "/MyChart-PRD"],
    ["https://h/mychart/Home", "https://h", "/mychart"],
    ["https://h/", "https://h", "/MyChart"],
    ["https://h", "https://h", "/MyChart"],
    ["not a url", "", "/MyChart"],
  ];
  for (const [url, origin, prefix] of cases) {
    test(url, () => {
      expect(deriveOriginPrefix(url)).toEqual({ origin, prefix });
    });
  }
});

describe("pickTarget", () => {
  const t = (url: string) => ({ url });
  test("case-insensitive substring match wins over order", () => {
    const targets = [t("https://a/other"), t("https://h/mychart/Home"), t("https://b/x")];
    expect(pickTarget(targets, "MyChart").url).toBe("https://h/mychart/Home");
  });
  test("falls back to first page when nothing matches", () => {
    const targets = [t("about:blank"), t("https://b/x")];
    expect(pickTarget(targets, "MyChart").url).toBe("about:blank");
  });
  test("throws when no targets", () => {
    expect(() => pickTarget([], "MyChart")).toThrow("no open pages");
  });
});
