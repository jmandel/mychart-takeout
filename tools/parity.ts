#!/usr/bin/env bun
/**
 * Parity diff between two export trees (e.g. Python export.py output vs the
 * bun CLI output run against the same live session).
 *
 *   bun tools/parity.ts <dirA> <dirB> [--ignore raw_network,dom,screenshots]
 *
 * Reports:
 *   - files present in only one tree (after normalizing ignorable dirs)
 *   - for structured/**.json present in both: differing top-level key sets
 *   - MANIFEST.json record_counts side by side
 * Exit code 1 when differences were found (beyond ignored dirs).
 *
 * PHI note: this reads exports locally and prints only file paths, JSON key
 * names, and counts — never field values.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const dirs = args.filter((a) => !a.startsWith("--"));
if (dirs.length !== 2) {
  console.error("usage: bun tools/parity.ts <dirA> <dirB> [--ignore d1,d2]");
  process.exit(2);
}
const [A, B] = dirs as [string, string];
const ignoreFlag = args.find((a) => a.startsWith("--ignore"));
const IGNORE = new Set(
  (ignoreFlag?.split("=")[1] ?? "raw_network,dom,screenshots").split(",").filter(Boolean),
);

function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(root, p);
      if (IGNORE.has(rel.split("/")[0]!)) continue;
      if (statSync(p).isDirectory()) rec(p);
      else out.push(rel);
    }
  };
  rec(root);
  return out.sort();
}

const filesA = new Set(walk(A));
const filesB = new Set(walk(B));
let diffs = 0;

const onlyA = [...filesA].filter((f) => !filesB.has(f));
const onlyB = [...filesB].filter((f) => !filesA.has(f));
if (onlyA.length) {
  diffs += onlyA.length;
  console.log(`\n== only in ${A} (${onlyA.length}) ==`);
  for (const f of onlyA) console.log("  " + f);
}
if (onlyB.length) {
  diffs += onlyB.length;
  console.log(`\n== only in ${B} (${onlyB.length}) ==`);
  for (const f of onlyB) console.log("  " + f);
}

function topKeys(path: string): string[] | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.keys(v).sort();
    if (Array.isArray(v)) return [`<array:${v.length}>`];
    return [`<${typeof v}>`];
  } catch {
    return null;
  }
}

console.log("\n== structured/ JSON top-level key diffs ==");
let keyDiffs = 0;
for (const f of filesA) {
  if (!filesB.has(f) || !f.startsWith("structured/") || !f.endsWith(".json")) continue;
  const ka = topKeys(join(A, f));
  const kb = topKeys(join(B, f));
  if (ka === null || kb === null) continue;
  const missB = ka.filter((k) => !kb.includes(k));
  const missA = kb.filter((k) => !ka.includes(k));
  if (missA.length || missB.length) {
    keyDiffs++;
    console.log(`  ${f}`);
    if (missB.length) console.log(`    only in A: ${missB.join(", ")}`);
    if (missA.length) console.log(`    only in B: ${missA.join(", ")}`);
  }
}
if (!keyDiffs) console.log("  (none)");
diffs += keyDiffs;

console.log("\n== MANIFEST.json record_counts ==");
for (const [label, dir] of [["A", A], ["B", B]] as const) {
  const p = join(dir, "MANIFEST.json");
  if (!existsSync(p)) {
    console.log(`  ${label}: (missing)`);
    continue;
  }
  try {
    const m = JSON.parse(readFileSync(p, "utf-8"));
    console.log(`  ${label} ${dir}: ${JSON.stringify(m.record_counts ?? {})}`);
  } catch {
    console.log(`  ${label}: (unreadable)`);
  }
}

console.log(diffs ? `\n${diffs} difference(s) found` : "\nparity OK");
process.exit(diffs ? 1 : 0);
