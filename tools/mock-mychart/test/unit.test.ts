import { describe, expect, test } from "bun:test";
import { unzipSync } from "../../../packages/browser/src/zip";
import { derivePrefix } from "../../../packages/browser/src/client";
import { ZipSink } from "../../../packages/browser/src/zipSink";
import { startMockMyChart } from "../src/server";

describe("ZipSink", () => {
  test("round-trips text and bytes through a real zip", async () => {
    const sink = new ZipSink();
    await sink.saveText("a/b.json", `{"x":1}`);
    await sink.saveBytes("c.bin", new Uint8Array([1, 2, 3]));
    const files = unzipSync(sink.finalize());
    expect(new TextDecoder().decode(files["a/b.json"]!)).toBe(`{"x":1}`);
    expect([...files["c.bin"]!]).toEqual([1, 2, 3]);
  });
});

describe("derivePrefix", () => {
  test.each([
    ["/MyChart/Home", "/MyChart"],
    ["/MyChart-PRD/app/test-results", "/MyChart-PRD"],
    ["/mychart/inside.asp", "/mychart"],
    ["/", "/MyChart"],
    ["", "/MyChart"],
  ])("%s → %s", (pathname, expected) => {
    expect(derivePrefix(pathname)).toBe(expected);
  });
});

describe("mock server", () => {
  test("serves CSRF page, enforces token on api POSTs, honors prefix", async () => {
    const mock = startMockMyChart({ prefix: "/MyChart-PRD" });
    try {
      const csrf = await fetch(`${mock.url}/MyChart-PRD/Home/CSRFToken`);
      expect(await csrf.text()).toContain("__RequestVerificationToken");

      const noTok = await fetch(`${mock.url}/MyChart-PRD/api/allergies/LoadAllergies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(noTok.status).toBe(403);

      const ok = await fetch(`${mock.url}/MyChart-PRD/api/allergies/LoadAllergies`, {
        method: "POST",
        headers: { "content-type": "application/json", __RequestVerificationToken: "t" },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      const outside = await fetch(`${mock.url}/MyChart/Home`);
      expect(outside.status).toBe(404);
    } finally {
      mock.stop();
    }
  });
});
