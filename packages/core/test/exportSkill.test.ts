import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_SKILL_MD } from "../src/exportSkill";
import { ExportStore } from "../src/store";
import { buildReport } from "../src/report/index";
import { MemorySink } from "./report/fixtures";

describe("baked-in export skill", () => {
  test("embedded constant matches export-skill/SKILL.md (run `bun run gen:skill` if this fails)", () => {
    const p = join(import.meta.dir, "..", "..", "..", "export-skill", "SKILL.md");
    expect(EXPORT_SKILL_MD).toBe(readFileSync(p, "utf-8"));
  });

  test("buildReport writes SKILL.md into the export", async () => {
    const sink = new MemorySink();
    await buildReport(new ExportStore(sink), { today: "2026-08-13" });
    expect(sink.files.get("SKILL.md")).toBe(EXPORT_SKILL_MD);
  });
});
