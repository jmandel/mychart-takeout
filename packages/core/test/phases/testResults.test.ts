import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import type { FetchInit } from "../../src/types";
import { bodyOf, FakeClient, FakeDom, makeTestCtx } from "../fixtures/harness";

const GETLIST = { orders: [{ name: "CBC Panel" }, { name: "Chest X-Ray" }] };

function clientWithDetails(): FakeClient {
  return new FakeClient({
    "api/test-results/GetList": GETLIST,
    "api/test-results/GetDetails": (init: FetchInit) => {
      const key = bodyOf(init).orderKey;
      if (key === "E1") return { results: [{ name: "CBC Panel" }] };
      if (key === "E2") return { results: [], orderName: "Chest X-Ray" };
      return {};
    },
  });
}

const domWithLinks = () =>
  new FakeDom({
    "app/test-results": {
      hrefs: [
        "details?eorderid=E1&extra=1",
        "/MyChart/app/test-results/details?eorderid=E2",
        null,
        "details?eorderid=E1", // duplicate — must dedupe
        "unrelated-link",
      ],
    },
  });

describe("testResults phase", () => {
  test("saves list, dedupes eorderids, names detail files deterministically", async () => {
    const c = clientWithDetails();
    const { ctx, sink } = makeTestCtx(c, { dom: domWithLinks() });
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

  test("derives eorderids from newResultGroups[].key without any dom access", async () => {
    // The primary path: no SPA page load — keys come straight from GetList.
    // This is what makes browser/bookmarklet mode work (framing app/* logs out).
    const c = new FakeClient({
      "api/test-results/GetList": {
        newResultGroups: [
          { key: "E1", name: "CBC Panel" },
          { key: "E2", name: "Chest X-Ray" },
          { key: "E1", name: "dup" }, // must dedupe
        ],
      },
      "api/test-results/GetDetails": (init: FetchInit) => {
        const key = bodyOf(init).orderKey;
        if (key === "E1") return { results: [{ name: "CBC Panel" }] };
        if (key === "E2") return { results: [], orderName: "Chest X-Ray" };
        return {};
      },
    });
    const { ctx, sink } = makeTestCtx(c); // no dom on purpose
    await phases.testResults(ctx);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual(["E1", "E2"]);
    expect(sink.has("structured/test-results/details/00_CBC_Panel.json")).toBe(true);
    expect(sink.has("structured/test-results/details/01_Chest_X_Ray.json")).toBe(true);
    // GetList keys mean the SPA page is never fetched
    expect(c.calls.some((x) => x.url.includes("app/test-results"))).toBe(false);
    const final = ctx.manifest.find((m) => m.endpoint === "GetDetails");
    expect(final?.note).toBe("2/2 orders");
  });

  test("list answered but keys unfindable → shape-mismatch gap naming the top keys", async () => {
    const c = clientWithDetails(); // GETLIST has no newResultGroups
    const { ctx, sink } = makeTestCtx(c); // no dom
    await phases.testResults(ctx);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual([]);
    const gap = ctx.manifest.find((m) => m.endpoint === "GetDetails");
    // The list DID answer ({orders:[...]}) — that's an exporter shape gap, not
    // "patient has no results"; the note names the keys so it's diagnosable.
    expect(gap?.outcome).toBe("shape-mismatch");
    expect(gap?.note).toContain("top keys: orders");
    expect(gap?.status).toBeNull();
  });

  test("falls back to dom link harvest when the list has no keys", async () => {
    const c = clientWithDetails();
    const { ctx, sink } = makeTestCtx(c, { dom: domWithLinks() });
    await phases.testResults(ctx);
    // GETLIST has no newResultGroups, so eorderids come from the rendered page
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual(["E1", "E2"]);
  });

  test("details request carries orderKey + PageNonce", async () => {
    const c = clientWithDetails();
    const { ctx } = makeTestCtx(c, { dom: domWithLinks() });
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
