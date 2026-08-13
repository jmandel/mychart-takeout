import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { ALEX_FLOWSHEETS, ALEX_READINGS_P0, ALEX_READINGS_P1 } from "../fixtures/alex";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

const FLOWSHEETS_REL = "structured/track-my-health/track-my-health__GetFlowsheets.json";

describe("flowsheets phase", () => {
  test("paginates readings by oldest ISO, stops when nothing new", async () => {
    const c = new FakeClient({
      "api/track-my-health/GetFlowsheetReadings": (init: FetchInit) => {
        const end = bodyOf(init).endInstantIso;
        return end === "" ? ALEX_READINGS_P0 : ALEX_READINGS_P1;
      },
    });
    const { ctx, sink } = makeTestCtx(c);
    ctx.store.primeJson(FLOWSHEETS_REL, ALEX_FLOWSHEETS);
    await phases.flowsheets(ctx);
    expect(sink.json("structured/track-my-health/readings/00_Blood_Pressure_p0.json")).toEqual(
      ALEX_READINGS_P0,
    );
    expect(sink.json("structured/track-my-health/readings/00_Blood_Pressure_p1.json")).toEqual(
      ALEX_READINGS_P1,
    );
    const calls = c.calls.filter((x) => x.url.endsWith("GetFlowsheetReadings"));
    expect(calls).toHaveLength(2);
    // second call paginates from the oldest ISO of page 0
    expect(bodyOf(calls[1]!.init).endInstantIso).toBe("2025-06-01T08:00");
    const rec = ctx.manifest.find((m) => m.endpoint === "GetFlowsheetReadings");
    expect(rec?.note).toBe("1 flowsheets");
  });

  test("stops when oldest ISO equals the current cursor", async () => {
    let calls = 0;
    const c = new FakeClient({
      "api/track-my-health/GetFlowsheetReadings": () => {
        calls++;
        // always one old reading (cursor) + one new unique reading
        return {
          readings: [
            { takenInstant: "2025-06-01T08:00" },
            { takenInstant: `2025-08-0${calls}T09:00` },
          ],
        };
      },
    });
    const { ctx } = makeTestCtx(c);
    ctx.store.primeJson(FLOWSHEETS_REL, ALEX_FLOWSHEETS);
    await phases.flowsheets(ctx);
    // page0: fresh, oldest 2025-06-01 ≠ "" → cursor; page1: fresh new ISO but
    // oldest === cursor → break after saving
    expect(calls).toBe(2);
  });

  test("stops on empty response (python falsy)", async () => {
    const c = new FakeClient({
      "api/track-my-health/GetFlowsheetReadings": {},
    });
    const { ctx, sink } = makeTestCtx(c);
    ctx.store.primeJson(FLOWSHEETS_REL, ALEX_FLOWSHEETS);
    await phases.flowsheets(ctx);
    expect(c.calls.filter((x) => x.url.endsWith("GetFlowsheetReadings"))).toHaveLength(1);
    expect(sink.keys("structured/track-my-health/readings/")).toEqual([]);
  });

  test("throws when GetFlowsheets.json is missing from the store", async () => {
    const { ctx } = makeTestCtx(new FakeClient());
    await expect(phases.flowsheets(ctx)).rejects.toThrow(/not in store/);
  });
});
