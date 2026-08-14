import type { DomAccess, SectionPage } from "@mychart/core";
import type { CdpPage } from "./page";

/**
 * DomAccess over the attached CDP page — real navigation in the user's tab.
 * Paths are prefix-relative, joined to origin+prefix.
 */
export function makeDomAccess(page: CdpPage, origin: string, prefix: string): DomAccess {
  const resolve = (path: string): string => {
    if (path.startsWith("http")) return path;
    if (path.startsWith("/")) return origin + path;
    return `${origin}${prefix}/${path}`;
  };

  return {
    async withSection<T>(
      path: string,
      settleMs: number,
      fn: (p: SectionPage) => Promise<T>,
    ): Promise<T> {
      const run = async (): Promise<T> => {
        try {
          await page.goto(resolve(path), { waitUntil: "domcontentloaded", timeout: 45000 });
        } catch {
          /* mirror python goto warn: continue to settle/snapshot anyway */
        }
        await page.waitForLoadState("networkidle", { timeout: 45000 });
        await page.waitForTimeout(settleMs);

        const section: SectionPage = {
          html: () => page.content(),
          text: async () =>
            (await page.evaluate("document.body ? document.body.innerText : \"\"")) as string,
          hrefs: async (selector: string) =>
            (await page.evaluate(
              `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))` +
                `.map((a) => a.getAttribute("href"))`,
            )) as (string | null)[],
        };
        return fn(section);
      };
      // Hard cap so one wedged section (dialog, target swap, renderer stall)
      // fails that section instead of the whole export.
      const capMs = 120000 + settleMs;
      let cap: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(),
          new Promise<never>((_, rej) => {
            cap = setTimeout(() => rej(new Error(`section ${path}: exceeded ${capMs}ms cap`)), capMs);
          }),
        ]);
      } finally {
        clearTimeout(cap);
      }
    },
  };
}
