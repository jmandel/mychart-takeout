import { zipSync } from "fflate";
import type { Sink } from "@mychart/core";

/**
 * Sink that accumulates the export tree in memory and zips it on demand —
 * the browser has no filesystem; the user receives one export.zip.
 */
export class ZipSink implements Sink {
  private files = new Map<string, Uint8Array>();
  private enc = new TextEncoder();

  async saveText(rel: string, text: string): Promise<void> {
    this.files.set(rel, this.enc.encode(text ?? ""));
  }

  async saveBytes(rel: string, bytes: Uint8Array): Promise<void> {
    this.files.set(rel, bytes);
  }

  entries(): ReadonlyMap<string, Uint8Array> {
    return this.files;
  }

  finalize(): Uint8Array {
    const tree: Record<string, Uint8Array> = {};
    for (const [rel, data] of this.files) tree[rel] = data;
    return zipSync(tree, { level: 6 });
  }
}
