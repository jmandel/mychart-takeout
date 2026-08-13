import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { salvage } from "../src/salvage";

const ORIGIN = "https://h";

function setup(lines: Record<string, unknown>[], bodies: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sv-"));
  mkdirSync(join(dir, "raw_network", "bodies"), { recursive: true });
  writeFileSync(
    join(dir, "raw_network", "responses.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  for (const [name, content] of Object.entries(bodies)) {
    writeFileSync(join(dir, "raw_network", name), content);
  }
  return dir;
}

describe("salvage (port of phase_salvage)", () => {
  test("keeps the biggest body per endpoint path and copies it", () => {
    const dir = setup(
      [
        { event: "response", status: 200, url: `${ORIGIN}/MyChart/api/foo/Load?x=1`, content_type: "application/json", body_file: "bodies/a.json", body_size: 10 },
        { event: "response", status: 200, url: `${ORIGIN}/MyChart/api/foo/Load?x=2`, content_type: "application/json", body_file: "bodies/b.json", body_size: 99 },
        { event: "response", status: 200, url: `${ORIGIN}/MyChart/Clinical/CareTeam/Load`, content_type: "application/json", body_file: "bodies/c.json", body_size: 5 },
      ],
      { "bodies/a.json": '{"n":"small"}', "bodies/b.json": '{"n":"big"}', "bodies/c.json": '{"n":"ct"}' },
    );
    const n = salvage(dir, ORIGIN);
    expect(n).toBe(2);
    const cap = join(dir, "structured", "_captured_from_navigation");
    const files = readdirSync(cap).sort();
    expect(files).toHaveLength(2);
    // the foo/Load winner is the bigger (b.json) body
    const foo = files.find((f) => f.includes("foo"))!;
    expect(JSON.parse(readFileSync(join(cap, foo), "utf-8")).n).toBe("big");
  });

  test("ignores non-200, wrong origin, non-json, and non-data paths", () => {
    const dir = setup(
      [
        { event: "response", status: 404, url: `${ORIGIN}/MyChart/api/x/Load`, content_type: "application/json", body_file: "bodies/a.json", body_size: 1 },
        { event: "response", status: 200, url: `https://evil/MyChart/api/x/Load`, content_type: "application/json", body_file: "bodies/a.json", body_size: 1 },
        { event: "response", status: 200, url: `${ORIGIN}/MyChart/api/x/Load`, content_type: "text/html", body_file: "bodies/a.json", body_size: 1 },
        { event: "response", status: 200, url: `${ORIGIN}/MyChart/static/thing`, content_type: "application/json", body_file: "bodies/a.json", body_size: 1 },
      ],
      { "bodies/a.json": "{}" },
    );
    expect(salvage(dir, ORIGIN)).toBe(0);
  });

  test("missing log → 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-"));
    expect(salvage(dir, ORIGIN)).toBe(0);
  });
});
