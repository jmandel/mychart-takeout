import type { Sink } from "./types";

/**
 * ExportStore: single write path for the export tree. Writes go to the
 * injected Sink; JSON values are ALSO retained in memory so later phases and
 * the report builder read them back without any filesystem (this replaces
 * export.py's pattern of re-reading files it just wrote — required for the
 * in-browser mode, where there is no fs).
 */
export class ExportStore {
  private mem = new Map<string, unknown>();
  /** Every rel path saved this run (any type) — used by the report manifest. */
  readonly savedFiles = new Set<string>();
  /** Saved size per rel path — lets the manifest explain a huge export
   *  (a single scanned document can dwarf everything else combined). */
  readonly savedSizes = new Map<string, number>();

  constructor(readonly sink: Sink) {}

  /** Pretty-printed JSON (matches Python json.dumps(indent=2, ensure_ascii=False)). */
  async saveJson(rel: string, value: unknown): Promise<void> {
    this.mem.set(rel, value);
    this.savedFiles.add(rel);
    const text = JSON.stringify(value, null, 2);
    this.savedSizes.set(rel, text.length);
    await this.sink.saveText(rel, text);
  }

  async saveText(rel: string, text: string): Promise<void> {
    this.savedFiles.add(rel);
    this.savedSizes.set(rel, (text ?? "").length);
    await this.sink.saveText(rel, text ?? "");
  }

  async saveBytes(rel: string, bytes: Uint8Array): Promise<void> {
    this.savedFiles.add(rel);
    this.savedSizes.set(rel, bytes.length);
    await this.sink.saveBytes(rel, bytes);
  }

  getJson(rel: string): unknown {
    return this.mem.get(rel);
  }

  has(rel: string): boolean {
    return this.mem.has(rel);
  }

  /** Saved-JSON [rel, value] pairs under a prefix, sorted by rel. */
  listJson(prefix: string): [string, unknown][] {
    return [...this.mem.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Pre-load a JSON value without writing (CLI `report` rebuild loads an
   * existing export dir into memory, then runs the report builder).
   */
  primeJson(rel: string, value: unknown): void {
    this.mem.set(rel, value);
  }
}
