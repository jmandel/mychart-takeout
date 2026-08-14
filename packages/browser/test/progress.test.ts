import { describe, expect, test } from "bun:test";
import { addProgress, fmtBytes, onProgress, resetProgress } from "../src/progress";

describe("fmtBytes", () => {
  test("humanizes across magnitudes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(950 * 1024)).toBe("950 KB");
    expect(fmtBytes(3.25 * 1024 * 1024)).toBe("3.3 MB");
  });
});

describe("progress counter", () => {
  test("accumulates, notifies the subscriber, and resets", () => {
    resetProgress();
    let seen: [number, number] = [-1, -1];
    onProgress((b, r) => (seen = [b, r]));
    expect(seen).toEqual([0, 0]); // subscriber called immediately
    addProgress(1000);
    addProgress(500);
    expect(seen).toEqual([1500, 2]);
    resetProgress();
    expect(seen).toEqual([0, 0]);
  });
});
