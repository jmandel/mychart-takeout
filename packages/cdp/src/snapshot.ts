import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The page surface snapshot() needs (CdpPage satisfies this). */
export interface SnapshotPage {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<void>;
}

/**
 * Port of harness/mychart.py Session.snapshot: dump DOM html/text/meta and a
 * full-page screenshot for a named view under the export dir.
 */
export async function snapshot(
  page: SnapshotPage,
  outDir: string,
  rawName: string,
): Promise<{ name: string; url: string; title: string | null; text_len?: number }> {
  const name = rawName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const domDir = join(outDir, "dom");
  const shotDir = join(outDir, "screenshots");
  mkdirSync(domDir, { recursive: true });
  mkdirSync(shotDir, { recursive: true });

  const info: { name: string; url: string; title: string | null; text_len?: number } = {
    name,
    url: page.url(),
    title: null,
  };
  try {
    info.title = await page.title();
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(join(domDir, `${name}.html`), await page.content(), "utf-8");
  } catch (e) {
    console.error(`[snapshot html warn] ${e}`);
  }
  try {
    const text = (await page.evaluate(
      "document.body ? document.body.innerText : \"\"",
    )) as string;
    writeFileSync(join(domDir, `${name}.txt`), text ?? "", "utf-8");
    info.text_len = (text ?? "").length;
  } catch (e) {
    console.error(`[snapshot text warn] ${e}`);
  }
  try {
    await page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: true });
  } catch (e) {
    console.error(`[snapshot shot warn] ${e}`);
  }
  writeFileSync(join(domDir, `${name}.meta.json`), JSON.stringify(info, null, 2));
  return info;
}
