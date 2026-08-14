import { describe, expect, test } from "bun:test";
import { crashedRun, likelyCulprit, type Journal } from "../src/journal";

function j(over: Partial<Journal>): Journal {
  return {
    runId: "r",
    host: "mychart.example.org",
    prefix: "/MyChart",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    exportStarted: true,
    events: [],
    ...over,
  };
}

describe("journal.likelyCulprit", () => {
  test("last '→' with no matching '✓' is the culprit (hard reload mid-request)", () => {
    expect(
      likelyCulprit(j({ events: ["+0.1s → POST a", "+0.2s ✓ 200 a", "+0.3s → POST b"] })),
    ).toBe("POST b");
  });
  test("null when the last request completed", () => {
    expect(likelyCulprit(j({ events: ["+0.1s → POST a", "+0.2s ✓ 200 a"] }))).toBeNull();
  });
});

describe("journal.crashedRun", () => {
  test("surfaces a recent, export-started, unfinished run", () => {
    expect(crashedRun(j({ status: "running", exportStarted: true }))).not.toBeNull();
    expect(crashedRun(j({ status: "logged-out", exportStarted: true }))).not.toBeNull();
  });
  test("ignores finished, never-started, or stale runs", () => {
    expect(crashedRun(j({ status: "done", exportStarted: true }))).toBeNull();
    expect(crashedRun(j({ status: "running", exportStarted: false }))).toBeNull();
    expect(crashedRun(j({ status: "running", exportStarted: true, updatedAt: Date.now() - 5 * 60 * 60 * 1000 }))).toBeNull();
    expect(crashedRun(null)).toBeNull();
  });
});
