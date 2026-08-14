import { describe, expect, test } from "bun:test";
import { DetailLoopGuard, findObservedAlternative, topKeys } from "../src/heal";

describe("findObservedAlternative", () => {
  const observed = [
    "/MyChartPRD/api/allergies/LoadAllergies",
    "/MyChartPRD/api/health-summary/FetchHealthSummary",
    "/MyChartPRD/Home/CSRFToken",
  ];

  test("matches the catalog Method at the app's real base", () => {
    expect(findObservedAlternative("api/allergies/LoadAllergies", "/MyChart", observed)).toBe(
      "/MyChartPRD/api/allergies/LoadAllergies",
    );
  });

  test("case-insensitive on the area/Method tail", () => {
    expect(findObservedAlternative("api/Allergies/loadallergies", "/MyChart", observed)).toBe(
      "/MyChartPRD/api/allergies/LoadAllergies",
    );
  });

  test("never suggests the path already tried", () => {
    expect(findObservedAlternative("api/allergies/LoadAllergies", "/MyChartPRD", observed)).toBeNull();
  });

  test("query strings on either side are ignored for matching", () => {
    expect(
      findObservedAlternative(
        "Clinical/CareTeam/Load?hfrId=&ComponentNumber=2",
        "/MyChart",
        ["/MyChartPRD/Clinical/CareTeam/Load?other=1"],
      ),
    ).toBe("/MyChartPRD/Clinical/CareTeam/Load");
  });

  test("no match → null", () => {
    expect(findObservedAlternative("api/goals/LoadPatientGoals", "/MyChart", observed)).toBeNull();
    expect(findObservedAlternative("short", "/MyChart", observed)).toBeNull();
  });
});

describe("DetailLoopGuard", () => {
  test("abandons after 3 failures with zero successes", () => {
    const g = new DetailLoopGuard();
    g.fail();
    g.fail();
    expect(g.abandoned()).toBe(false);
    g.fail();
    expect(g.abandoned()).toBe(true);
  });

  test("one success ever disables abandonment (mixed collections finish)", () => {
    const g = new DetailLoopGuard();
    g.ok();
    for (let i = 0; i < 20; i++) g.fail();
    expect(g.abandoned()).toBe(false);
  });
});

describe("topKeys", () => {
  test("names only, capped, arrays and scalars described", () => {
    expect(topKeys({ a: 1, b: "secret-value" })).toBe("a,b");
    expect(topKeys([1, 2, 3])).toBe("array[3]");
    expect(topKeys("x")).toBe("string");
    const wide = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
    expect(topKeys(wide)).toContain(",…");
  });
});
