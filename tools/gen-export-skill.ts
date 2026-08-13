#!/usr/bin/env bun
/**
 * Codegen: embed export-skill/SKILL.md into an isomorphic core constant so it
 * can be baked into every export (browser mode has no filesystem at runtime).
 * Source of truth is the markdown; run `bun run gen:skill` after editing it.
 * A drift test (packages/core/test/exportSkill.test.ts) keeps them in sync.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const md = readFileSync(join(root, "export-skill", "SKILL.md"), "utf-8");
const out = join(root, "packages", "core", "src", "exportSkill.ts");
const banner =
  "// AUTO-GENERATED from export-skill/SKILL.md by tools/gen-export-skill.ts.\n" +
  "// Do not edit by hand; edit the markdown and run `bun run gen:skill`.\n";
writeFileSync(out, `${banner}export const EXPORT_SKILL_MD = ${JSON.stringify(md)};\n`);
console.log(`wrote ${out} (${md.length} chars)`);
