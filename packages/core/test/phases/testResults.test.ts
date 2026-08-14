import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { bodyOf, FakeClient, makeTestCtx } from "../fixtures/harness";

// Real MyChart exposes the per-order key (eorderid) in newResultGroups[].key —
// the ONLY key source (verified across UnityPoint/UW/MGB, incl. bookmarklet
// runs where no page rendering exists at all).
const GETLIST = {
  newResultGroups: [
    { key: "E1", name: "CBC Panel" },
    { key: "E2", name: "Chest X-Ray" },
    { key: "E1", name: "dup" }, // must dedupe
  ],
};

function clientWithDetails(list: unknown = GETLIST): FakeClient {
  return new FakeClient({
    "api/test-results/GetList": list,
    "api/test-results/GetDetails": (init: FetchInit) => {
      const key = bodyOf(init).orderKey;
      if (key === "E1") return { results: [{ name: "CBC Panel" }] };
      if (key === "E2") return { results: [], orderName: "Chest X-Ray" };
      return {};
    },
  });
}

describe("testResults phase", () => {
  test("derives + dedupes eorderids from the list, names detail files deterministically", async () => {
    const c = clientWithDetails();
    const { ctx, sink } = makeTestCtx(c);
    await phases.testResults(ctx);
    expect(sink.json("structured/test-results/GetList.json")).toEqual(GETLIST);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual(["E1", "E2"]);
    expect(sink.json("structured/test-results/details/00_CBC_Panel.json")).toEqual({
      eorderid: "E1",
      detail: { results: [{ name: "CBC Panel" }] },
    });
    // empty results[] → falls back to orderName
    expect(sink.has("structured/test-results/details/01_Chest_X_Ray.json")).toBe(true);
    const final = ctx.manifest.find((m) => m.endpoint === "GetDetails");
    expect(final?.note).toBe("2/2 orders");
  });

  test("list answered but keys unfindable → shape-mismatch gap naming the top keys", async () => {
    const c = clientWithDetails({ orders: [{ name: "CBC Panel" }] }); // no newResultGroups
    const { ctx, sink } = makeTestCtx(c);
    await phases.testResults(ctx);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual([]);
    const gap = ctx.manifest.find((m) => m.endpoint === "GetDetails");
    // The list DID answer ({orders:[...]}) — that's an exporter shape gap, not
    // "patient has no results"; the note names the keys so it's diagnosable.
    expect(gap?.outcome).toBe("shape-mismatch");
    expect(gap?.note).toContain("top keys: orders");
    expect(gap?.status).toBeNull();
  });

  test("details request carries orderKey + PageNonce", async () => {
    const c = clientWithDetails();
    const { ctx } = makeTestCtx(c);
    await phases.testResults(ctx);
    const det = c.calls.filter((x) => x.url.endsWith("GetDetails"));
    expect(det).toHaveLength(2);
    expect(bodyOf(det[0]!.init)).toEqual({
      orderKey: "E1",
      organizationID: "",
      PageNonce: "deadbeef",
    });
  });
});
