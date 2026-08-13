import { describe, expect, test } from "bun:test";
import { CdpClient, type EvalPage } from "../src/client";

/** Stub page: captures the evaluated expression, returns a canned value. */
function stubPage(canned: unknown): { page: EvalPage; exprs: string[] } {
  const exprs: string[] = [];
  const page: EvalPage = {
    evaluate: async (expression: string) => {
      exprs.push(expression);
      return canned;
    },
  };
  return { page, exprs };
}

describe("CdpClient", () => {
  test("fetchText resolves relative path against origin and maps result", async () => {
    const { page, exprs } = stubPage({
      status: 200,
      content_type: "application/json",
      url: "https://h/MyChart/api/x",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    const c = new CdpClient(page, "https://h", "/MyChart");
    const r = await c.fetchText("/MyChart/api/x", {
      method: "POST",
      headers: { __RequestVerificationToken: "t" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/json");
    expect(r.body).toBe('{"ok":true}');
    // args are embedded into the expression as JSON
    const expr = exprs[0]!;
    expect(expr).toContain(JSON.stringify("https://h/MyChart/api/x"));
    expect(expr).toContain('"method":"POST"');
    expect(expr).toContain('"__RequestVerificationToken":"t"');
    expect(expr).toContain('"body":"{}"');
    expect(expr).toContain("credentials");
  });

  test("fetchText leaves absolute URLs untouched", async () => {
    const { page, exprs } = stubPage({ status: 200, content_type: null, url: "u", headers: {}, body: "" });
    const c = new CdpClient(page, "https://h", "/MyChart");
    await c.fetchText("https://other/x");
    expect(exprs[0]!).toContain(JSON.stringify("https://other/x"));
  });

  test("fetchBytes base64-decodes to bytes", async () => {
    const raw = new Uint8Array([0, 1, 2, 250, 255]);
    const b64 = Buffer.from(raw).toString("base64");
    const { page } = stubPage({ status: 200, b64 });
    const c = new CdpClient(page, "https://h", "/MyChart");
    const r = await c.fetchBytes("/MyChart/Documents/Released/Download?x=1");
    expect(r.status).toBe(200);
    expect([...r.bytes]).toEqual([0, 1, 2, 250, 255]);
  });

  test("in-page exception propagates as a thrown error", async () => {
    const page: EvalPage = {
      evaluate: async () => {
        throw new Error("page evaluate failed: TypeError: Failed to fetch");
      },
    };
    const c = new CdpClient(page, "https://h", "/MyChart");
    expect(c.fetchText("/MyChart/api/x")).rejects.toThrow("Failed to fetch");
  });
});
