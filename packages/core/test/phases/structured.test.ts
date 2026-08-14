import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import { ALEX_ALLERGIES, ALEX_FLOWSHEETS, ALEX_HEALTH_SUMMARY } from "../fixtures/alex";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

describe("structured phase", () => {
  const client = () =>
    new FakeClient({
      "api/allergies/LoadAllergies": ALEX_ALLERGIES,
      "api/health-summary/FetchHealthSummary": ALEX_HEALTH_SUMMARY,
      "api/track-my-health/GetFlowsheets": ALEX_FLOWSHEETS,
      "Clinical/Medications/LoadExternal": { externalMeds: [] },
      "Clinical/CareTeam/Load": "<html>shell</html>", // SPA shell → not saved
    });

  test("saves SIMPLE endpoints under structured/<domain>/<name>.json", async () => {
    const c = client();
    const { ctx, sink } = makeTestCtx(c);
    await phases.structured(ctx);
    expect(sink.json("structured/allergies/allergies__LoadAllergies.json")).toEqual(
      ALEX_ALLERGIES,
    );
    expect(
      sink.json("structured/health-summary/health-summary__FetchHealthSummary.json"),
    ).toEqual(ALEX_HEALTH_SUMMARY);
    expect(
      sink.json("structured/track-my-health/track-my-health__GetFlowsheets.json"),
    ).toEqual(ALEX_FLOWSHEETS);
  });

  test("unrouted SIMPLE endpoints fall back to {_raw} (non-JSON body)", async () => {
    const { ctx, sink } = makeTestCtx(client());
    await phases.structured(ctx);
    expect(sink.json("structured/immunizations/immunizations__LoadImmunizations.json")).toEqual({
      _raw: "<html>SPA shell</html>",
    });
  });

  test("resolves body sentinels (NONCE, UPCOMING, ITEMFEED)", async () => {
    const c = client();
    const { ctx } = makeTestCtx(c);
    await phases.structured(ctx);
    const goals = c.calls.find((x) => x.url.endsWith("api/goals/LoadPatientGoals"))!;
    expect(bodyOf(goals.init)).toEqual({ PageNonce: "deadbeef" });
    const upcoming = c.calls.find((x) =>
      x.url.endsWith("api/upcoming-orders/GetUpcomingOrders"),
    )!;
    expect(bodyOf(upcoming.init)).toEqual({ selectedOrderID: "", PageNonce: "deadbeef" });
    const feed = c.calls.find((x) => x.url.endsWith("api/item-feed/FetchItemFeed"))!;
    expect(bodyOf(feed.init)).toEqual({
      timeZone: "UTC",
      feedHost: 1,
      conditionViewHfrID: "",
    });
  });

  test("CLASSIC json responses saved with query-stripped __ name", async () => {
    const { ctx, sink } = makeTestCtx(client());
    await phases.structured(ctx);
    expect(
      sink.json("structured/medications-ext/Clinical__Medications__LoadExternal.json"),
    ).toEqual({ externalMeds: [] });
  });

  test("CLASSIC shell responses are not saved and recorded as gaps", async () => {
    const { ctx, sink } = makeTestCtx(client());
    await phases.structured(ctx);
    expect(sink.has("structured/care-team/Clinical__CareTeam__Load.json")).toBe(false);
    const gap = ctx.manifest.find(
      (m) => m.domain === "care-team" && String(m.endpoint).startsWith("Clinical/CareTeam/Load?"),
    );
    expect(gap?.note).toBe("shell-response (recovered via salvage/dom)");
  });

  test("care-team/covid go through nobody POST with query params intact", async () => {
    const c = client();
    const { ctx } = makeTestCtx(c);
    await phases.structured(ctx);
    const load = c.calls.find((x) => x.url.includes("Clinical/CareTeam/Load?"))!;
    expect(load.url).toBe(
      "/MyChart/Clinical/CareTeam/Load?hfrId=&sources=&actions=&isPrimaryStandalone=true&ComponentNumber=2",
    );
    expect(load.init.method).toBe("POST");
    expect(load.init.body).toBeUndefined();
  });

  test("manifest records every SIMPLE endpoint", async () => {
    const { ctx } = makeTestCtx(client());
    await phases.structured(ctx);
    const simpleRecs = ctx.manifest.filter((m) => m.endpoint === "allergies/LoadAllergies");
    expect(simpleRecs).toHaveLength(1);
    expect(simpleRecs[0]!.status).toBe(200);
  });
});

describe("structured phase respects the abort signal", () => {
  test("makes no calls once the session is flagged logged-out", async () => {
    const c = new FakeClient({});
    const { ctx } = makeTestCtx(c);
    ctx.signal.aborted = true;
    await phases.structured(ctx);
    expect(c.calls.length).toBe(0);
  });
});
