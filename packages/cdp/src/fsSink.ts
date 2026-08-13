import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Sink } from "@mychart/core";
import { ExportStore } from "@mychart/core";

/** Filesystem Sink rooted at an output directory. */
export class FsSink implements Sink {
  constructor(readonly outDir: string) {}

  private abs(rel: string): string {
    const p = join(this.outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    return p;
  }

  async saveText(rel: string, text: string): Promise<void> {
    writeFileSync(this.abs(rel), text ?? "", "utf-8");
  }

  async saveBytes(rel: string, bytes: Uint8Array): Promise<void> {
    writeFileSync(this.abs(rel), bytes);
  }
}

/**
 * Load an existing export directory's JSON files into a store (for the
 * standalone `report` command, which rebuilds summaries with no session).
 * Keys are forward-slash rel paths, matching what the phases wrote.
 */
export function loadExportDirIntoStore(store: ExportStore, outDir: string): number {
  let n = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (name.endsWith(".json")) {
        const rel = relative(outDir, full).split(sep).join("/");
        try {
          store.primeJson(rel, JSON.parse(readFileSync(full, "utf-8")));
          n++;
        } catch {
          /* skip unparseable */
        }
      }
    }
  };
  walk(outDir);
  return n;
}
