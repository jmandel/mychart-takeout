import { describe, expect, test } from "bun:test";
import { phases } from "../../src/phases/index";
import { shellOverlap } from "../../src/phases/dom";
import { FakeClient, FakeDom, makeTestCtx } from "../fixtures/harness";

const SHELL = Array.from({ length: 50 }, (_, i) => `shell chrome line ${i}`).join("\n");

describe("shellOverlap", () => {
  test("identical page → 1; empty page → 1; disjoint → 0", () => {
    expect(shellOverlap(SHELL, SHELL)).toBe(1);
    expect(shellOverlap("", SHELL)).toBe(1);
    expect(shellOverlap("totally different content", SHELL)).toBe(0);
  });
  test("shell plus real content scores below the skip threshold", () => {
    const page = SHELL + "\nAmount Due\n$123.45\nGuarantor #999\nView balance details";
    expect(shellOverlap(page, SHELL)).toBeLessThan(0.98);
  });
});

describe("dom phase", () => {
  test("saves real pages, skips shell-identical and empty ones, records the split", async () => {
    const fakeDom = new FakeDom(
      {
        "app/__mct_shell_probe__": { text: SHELL },
        Home: { html: "<html>home</html>", text: "Welcome Alex\nYour health, in one place." },
        // renders exactly the shell → boilerplate, must not be saved
        "Clinical/TestResults": { html: "<html>shell</html>", text: SHELL },
        // shell + real billing facts → must be saved
        "Billing/Summary": { html: "<html>bill</html>", text: SHELL + "\nAmount Due\n$0.00\nGuarantor #123" },
        // every other section defaults to empty text → boilerplate, skipped
      },
      true,
    );
    const { ctx, sink } = makeTestCtx(new FakeClient(), { dom: fakeDom, screenshots: true });
    await phases.dom(ctx);
    expect(sink.text("dom/home.txt")).toContain("Welcome Alex");
    expect(sink.text("dom/billing-summary.txt")).toContain("Amount Due");
    expect(sink.keys("dom/").sort()).toEqual([
      "dom/billing-summary.html",
      "dom/billing-summary.txt",
      "dom/home.html",
      "dom/home.txt",
    ]);
    // screenshots only for pages worth keeping
    expect(fakeDom.shots.sort()).toEqual(["screenshots/billing-summary.png", "screenshots/home.png"]);
    const rec = ctx.manifest.find((m) => m.domain === "dom");
    expect(rec?.note).toBe("2 pages saved, 17 skipped (app-shell boilerplate)");
  });

  test("no baseline (probe fails) → saves everything with content, as before", async () => {
    const fakeDom = new FakeDom({
      Home: { text: "Welcome Alex" },
      "Clinical/TestResults": { text: SHELL },
    });
    // FakeDom serves "" for the probe → empty baseline → only empty pages skip
    const { ctx, sink } = makeTestCtx(new FakeClient(), { dom: fakeDom });
    await phases.dom(ctx);
    expect(sink.keys("dom/")).toContain("dom/home.txt");
    expect(sink.keys("dom/")).toContain("dom/test-results.txt");
    expect(ctx.manifest.find((m) => m.domain === "dom")?.note).toContain("2 pages saved");
  });

  test("silently no-op without dom access", async () => {
    const { ctx, sink } = makeTestCtx(new FakeClient());
    await phases.dom(ctx);
    expect(sink.keys("")).toEqual([]);
  });
});
