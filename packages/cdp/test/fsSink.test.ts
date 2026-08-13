import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportStore } from "@mychart/core";
import { FsSink, loadExportDirIntoStore } from "../src/fsSink";

describe("FsSink", () => {
  test("writes nested text + bytes, creating dirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-"));
    const sink = new FsSink(dir);
    await sink.saveText("structured/a/b.json", '{"x":1}');
    await sink.saveBytes("documents/ccda/pkg.zip", new Uint8Array([1, 2, 3]));
    expect(readFileSync(join(dir, "structured/a/b.json"), "utf-8")).toBe('{"x":1}');
    expect([...readFileSync(join(dir, "documents/ccda/pkg.zip"))]).toEqual([1, 2, 3]);
  });
});

describe("loadExportDirIntoStore", () => {
  test("primes store with forward-slash rel keys for every json", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-"));
    mkdirSync(join(dir, "structured", "allergies"), { recursive: true });
    writeFileSync(join(dir, "structured", "allergies", "LoadAllergies.json"), '{"dataList":[]}');
    writeFileSync(join(dir, "_manifest.json"), "[]");
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const store = new ExportStore(new FsSink(dir));
    const n = loadExportDirIntoStore(store, dir);
    expect(n).toBe(2);
    expect(store.getJson("structured/allergies/LoadAllergies.json")).toEqual({ dataList: [] });
    expect(store.getJson("_manifest.json")).toEqual([]);
  });
});
