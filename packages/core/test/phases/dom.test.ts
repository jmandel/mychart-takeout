import { describe, expect, test } from "bun:test";
import { SECTIONS } from "../../src/catalog";
import { phases } from "../../src/phases/index";
import { FakeClient, FakeDom, makeTestCtx } from "../fixtures/harness";

describe("dom phase", () => {
  test("saves html + txt for every section; screenshots only when enabled+capable", async () => {
    const fakeDom = new FakeDom(
      { Home: { html: "<html>home</html>", text: "Welcome Alex" } },
      true,
    );
    const { ctx, sink } = makeTestCtx(new FakeClient(), { dom: fakeDom, screenshots: true });
    await phases.dom(ctx);
    expect(sink.text("dom/home.html")).toBe("<html>home</html>");
    expect(sink.text("dom/home.txt")).toBe("Welcome Alex");
    expect(fakeDom.visited).toEqual(SECTIONS.map(([, p]) => p));
    expect(fakeDom.shots).toEqual(SECTIONS.map(([n]) => `screenshots/${n}.png`));
    expect(sink.keys("dom/")).toHaveLength(SECTIONS.length * 2);
  });

  test("no screenshots when flag off", async () => {
    const fakeDom = new FakeDom({}, true);
    const { ctx } = makeTestCtx(new FakeClient(), { dom: fakeDom });
    await phases.dom(ctx);
    expect(fakeDom.shots).toEqual([]);
  });

  test("silently no-op without dom access", async () => {
    const { ctx, sink } = makeTestCtx(new FakeClient());
    await phases.dom(ctx);
    expect(sink.keys("")).toEqual([]);
  });
});
