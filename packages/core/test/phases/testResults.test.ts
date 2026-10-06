import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import { renderGapsMd, summarizeGaps } from "../../src/gaps";
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
    expect(final?.note).toBe("2/2 discovered orders saved; list unverified");
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

// Entirely synthetic pagination fixtures: no exported records or opaque portal IDs.
function listPage(keys: string[], cursor: string, complete = false) {
  return {
    groupBy: "ORDER",
    areResultsFullyLoaded: complete,
    isGroupingFullyLoaded: complete,
    organizationLoadMoreInfo: { "synthetic-org": { lastGroupKey: cursor, uniqueGroupCount: keys.length } },
    newResultGroups: keys.map((key) => ({ key, resultList: [key] })),
    newResults: Object.fromEntries(keys.map((key) => [`${key}^`, { key, name: "Synthetic result" }])),
    newProviderPhotoInfo: { "synthetic-provider": { name: "Example provider" } },
    newComments: { "synthetic-comment": { text: "Example comment" } },
  };
}

function paginated(pages: unknown[]) {
  let page = 0;
  const c = new FakeClient({
    "api/test-results/GetList": () => pages[Math.min(page++, pages.length - 1)],
    "api/test-results/GetDetails": () => ({ results: [{ name: "Synthetic result" }] }),
  });
  return { c, ...makeTestCtx(c) };
}

function listCalls(c: FakeClient) {
  return c.calls.filter((v) => v.url.endsWith("/GetList")).map((v) => bodyOf(v.init));
}

describe("testResults pagination", () => {
  test("server caps pages at 100: all 205 synthetic orders survive overlapping pages", async () => {
    const keys = Array.from({ length: 205 }, (_, i) => `synthetic-order-${i}`);
    const pages = [
      listPage(keys.slice(0, 100), "cursor-100"),
      listPage(keys.slice(99, 199), "cursor-199"),
      listPage(keys.slice(199), "cursor-end", true),
    ];
    const { c, ctx, sink } = paginated(pages);
    await phases.testResults(ctx);
    expect(listCalls(c)).toEqual([
      { groupType: "UNINITIALIZED", searchString: "", maxResults: 9999 },
      { groupType: "ORDER", searchString: "", maxResults: 9999, lastGroupKeys: { "synthetic-org": "cursor-100" } },
      { groupType: "ORDER", searchString: "", maxResults: 9999, lastGroupKeys: { "synthetic-org": "cursor-199" } },
    ]);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual(keys);
    expect(sink.keys("structured/test-results/details/")).toHaveLength(205);
    // Preserve the source envelopes, including maps, grouping, flags and overlap.
    expect(sink.json("structured/test-results/GetList.json")).toEqual(pages[0]);
    expect(sink.json("structured/test-results/GetList_page_2.json")).toEqual(pages[1]);
    expect(sink.json("structured/test-results/GetList_page_3.json")).toEqual(pages[2]);
    expect(sink.json("structured/test-results/_pagination.json")).toMatchObject({ completeness: "complete", pages: 3, discoveredOrders: 205 });
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });

  test("complete one-page and empty lists do not request continuation", async () => {
    for (const keys of [["synthetic-order"], []]) {
      const { c, ctx, sink } = paginated([listPage(keys, "", true)]);
      await phases.testResults(ctx);
      expect(listCalls(c)).toHaveLength(1);
      expect(sink.json("structured/test-results/_detail_links.json")).toEqual(keys);
      expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
    }
  });

  test("either false completion flag requires more pages, even on an empty page", async () => {
    for (const flags of [
      { areResultsFullyLoaded: true, isGroupingFullyLoaded: false },
      { areResultsFullyLoaded: false, isGroupingFullyLoaded: true },
    ]) {
      const { c, ctx, sink } = paginated([
        { ...listPage([], "cursor-empty"), ...flags }, listPage(["synthetic-order"], "", true),
      ]);
      await phases.testResults(ctx);
      expect(listCalls(c)).toHaveLength(2);
      expect(sink.json("structured/test-results/_detail_links.json")).toEqual(["synthetic-order"]);
    }
  });

  test("a duplicate-only page with a fresh cursor can precede older orders", async () => {
    const { c, ctx, sink } = paginated([
      listPage(["synthetic-one"], "cursor-one"),
      listPage(["synthetic-one"], "cursor-two"),
      listPage(["synthetic-two"], "", true),
    ]);
    await phases.testResults(ctx);
    expect(listCalls(c)).toHaveLength(3);
    expect(sink.json("structured/test-results/_detail_links.json")).toEqual(["synthetic-one", "synthetic-two"]);
  });

  test("encounter groups and organization cursors retain their source; dedupe is per source", async () => {
    const first = {
      ...listPage([], ""), groupBy: "ENCOUNTER",
      organizationLoadMoreInfo: {
        "org-b": { lastGroupKey: "group-b", uniqueGroupCount: 1 },
        "org-a": { lastGroupKey: "group-a", uniqueGroupCount: 1 },
      },
      newResultGroups: [
        { key: "group-a", organizationID: "org-a", resultList: ["order-shared", "order-a"] },
        { key: "group-b", organizationID: "org-b", resultList: ["order-shared"] },
      ],
    };
    const last = { ...first, areResultsFullyLoaded: true, isGroupingFullyLoaded: true };
    const { c, ctx, sink } = paginated([first, last]);
    await phases.testResults(ctx);
    expect(listCalls(c)[1]).toMatchObject({ groupType: "ENCOUNTER", lastGroupKeys: { "org-a": "group-a", "org-b": "group-b" } });
    expect(c.calls.filter((v) => v.url.endsWith("/GetDetails")).map((v) => bodyOf(v.init))).toEqual([
      { orderKey: "order-shared", organizationID: "org-a", PageNonce: "deadbeef" },
      { orderKey: "order-a", organizationID: "org-a", PageNonce: "deadbeef" },
      { orderKey: "order-shared", organizationID: "org-b", PageNonce: "deadbeef" },
    ]);
    expect(sink.json("structured/test-results/details/02_Synthetic_result.json")).toMatchObject({ eorderid: "order-shared", organizationID: "org-b" });
    expect(sink.json("structured/test-results/GetList.json")).toEqual(first);
  });

  test("repeated and cycling cursors stop and report incompleteness without logging cursor values", async () => {
    for (const pages of [
      [listPage(["synthetic-one"], "synthetic-secret-cursor")],
      [listPage(["synthetic-one"], "synthetic-secret-cursor"), listPage([], "cursor-two"), listPage([], "synthetic-secret-cursor")],
    ]) {
      const { c, ctx, sink, logs } = paginated(pages);
      await phases.testResults(ctx);
      expect(listCalls(c)).toHaveLength(pages.length === 1 ? 2 : 3);
      expect(sink.json("structured/test-results/_pagination.json")).toMatchObject({ completeness: "incomplete", reason: "more results reported but continuation cursor repeated" });
      const gaps = renderGapsMd(summarizeGaps(ctx.manifest));
      expect(gaps).toContain("incomplete");
      expect(gaps).not.toContain("No failed or degraded endpoints");
      expect(gaps + logs.join("\n")).not.toContain("synthetic-secret-cursor");
      expect(ctx.manifest.at(-1)?.note).toBe("1/1 discovered orders saved; list incomplete");
    }
  });

  test("partial organization cursor updates retain the other organizations' positions", async () => {
    const { c, ctx } = paginated([
      { ...listPage([], ""), organizationLoadMoreInfo: {
        "org-a": { lastGroupKey: "cursor-a" }, "org-b": { lastGroupKey: "cursor-b" },
      } },
      { ...listPage([], ""), organizationLoadMoreInfo: { "org-a": { lastGroupKey: "cursor-a2" } } },
      listPage([], "", true),
    ]);
    await phases.testResults(ctx);
    expect(listCalls(c)[2]?.lastGroupKeys).toEqual({ "org-a": "cursor-a2", "org-b": "cursor-b" });
    expect(summarizeGaps(ctx.manifest).concerns).toEqual([]);
  });

  test("missing/malformed cursors or grouping leave a visible gap and preserve discovered orders", async () => {
    for (const override of [
      { organizationLoadMoreInfo: undefined }, { organizationLoadMoreInfo: {} },
      { organizationLoadMoreInfo: { "org-a": null } },
      { organizationLoadMoreInfo: { "org-a": { lastGroupKey: 7 } } },
      { organizationLoadMoreInfo: { "org-a": { lastGroupKey: "" } } },
      { groupBy: undefined }, { groupBy: "UNINITIALIZED" },
    ]) {
      const { c, ctx, sink } = paginated([{ ...listPage(["synthetic-one"], "cursor"), ...override }]);
      await phases.testResults(ctx);
      expect(listCalls(c)).toHaveLength(1);
      expect(sink.keys("structured/test-results/details/")).toHaveLength(1);
      expect(summarizeGaps(ctx.manifest).concerns.some((r) => r.outcome === "incomplete")).toBe(true);
    }
  });

  test("missing flags are unverified, and grouping changes cannot claim completion", async () => {
    for (const pages of [
      [GETLIST],
      [listPage(["synthetic-one"], "cursor"), { ...listPage(["synthetic-two"], "", true), groupBy: "ENCOUNTER" }],
      [listPage(["synthetic-one"], "cursor"), { ...listPage([], ""), areResultsFullyLoaded: undefined, isGroupingFullyLoaded: undefined }],
    ]) {
      const { ctx, sink } = paginated(pages);
      await phases.testResults(ctx);
      expect(sink.json("structured/test-results/_pagination.json")).not.toMatchObject({ completeness: "complete" });
      expect(summarizeGaps(ctx.manifest).concerns.some((r) => r.outcome === "incomplete")).toBe(true);
    }
  });

  test("an advancing cursor with no terminal flag hits a finite safety limit", async () => {
    const { c, ctx, sink } = paginated([]);
    let i = 0;
    c.route("api/test-results/GetList", () => listPage([], `cursor-${++i}`));
    await phases.testResults(ctx);
    expect(listCalls(c)).toHaveLength(100);
    expect(sink.json("structured/test-results/_pagination.json")).toMatchObject({ completeness: "incomplete", reason: "list page limit reached" });
  });

  test("completion flags cannot hide malformed result groups", async () => {
    for (const group of [null, {}, { key: "synthetic-one", resultList: "unexpected" },
      { key: "synthetic-one", resultList: [7] }, { key: "synthetic-one", organizationID: 7 }]) {
      const { ctx, sink } = paginated([{ ...listPage([], "", true), newResultGroups: [group] }]);
      await phases.testResults(ctx);
      expect(sink.json("structured/test-results/_pagination.json")).toMatchObject({ completeness: "incomplete" });
      expect(summarizeGaps(ctx.manifest).concerns.some((v) => v.outcome === "shape-mismatch")).toBe(true);
    }
  });

  test("HTTP, non-JSON and thrown continuation failures retain previous pages and their details", async () => {
    for (const failure of ["http", "html", "throw"] as const) {
      const { c, ctx, sink } = paginated([listPage(["synthetic-one"], "cursor")]);
      const original = c.fetchText.bind(c);
      let lists = 0;
      c.fetchText = async (url, init) => {
        if (url.endsWith("/GetList") && ++lists > 1) {
          if (failure === "throw") throw new Error("synthetic network failure");
          return { status: failure === "http" ? 500 : 200, url, contentType: failure === "http" ? "application/json" : "text/html", body: failure === "http" ? '{"error":"synthetic"}' : "<html>synthetic shell</html>" };
        }
        return original(url, init);
      };
      await phases.testResults(ctx);
      expect(sink.keys("structured/test-results/details/")).toHaveLength(1);
      expect(sink.json("structured/test-results/_pagination.json")).toMatchObject({ completeness: "incomplete", pages: 1 });
      const concerns = summarizeGaps(ctx.manifest).concerns;
      expect(concerns.some((r) => r.outcome === ({ http: "server-error", html: "spa-shell", throw: "network-error" })[failure])).toBe(true);
      expect(concerns.some((r) => r.outcome === "incomplete")).toBe(true);
    }
  });

  test("a run aborted during discovery skips subsequent requests and reports incomplete", async () => {
    const { c, ctx, sink } = paginated([]);
    c.route("api/test-results/GetList", () => {
      ctx.signal.aborted = true;
      return listPage(["synthetic-one"], "cursor");
    });
    await phases.testResults(ctx);
    expect(listCalls(c)).toHaveLength(1);
    expect(c.calls.filter((v) => v.url.endsWith("/GetDetails"))).toHaveLength(0);
    expect(sink.json("structured/test-results/_pagination.json")).toMatchObject({ completeness: "incomplete" });
    expect(ctx.manifest.at(-1)).toMatchObject({ outcome: "incomplete", note: "0/1 discovered orders saved; list incomplete" });
  });

  test("failed details are a gap even after a complete list", async () => {
    const { c, ctx, sink } = paginated([listPage(["synthetic-one"], "", true)]);
    c.route("api/test-results/GetDetails", () => ({ error: "synthetic failure" }));
    await phases.testResults(ctx);
    expect(sink.keys("structured/test-results/details/")).toHaveLength(0);
    expect(ctx.manifest.at(-1)).toMatchObject({ outcome: "incomplete", note: "0/1 discovered orders saved; list complete" });
    expect(summarizeGaps(ctx.manifest).concerns.some((v) => v.outcome === "shape-mismatch")).toBe(true);
  });
});
