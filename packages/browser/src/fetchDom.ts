import type { DomAccess, SectionPage } from "@mychart/core";

/**
 * DomAccess by fetching each section's HTML and parsing it inertly with
 * DOMParser — the scripts in the returned markup never execute.
 *
 * Why not a hidden iframe: framing an Epic `app/*` SPA route boots its client,
 * which detects it is framed and navigates itself to `Home/LogOut`, killing
 * the whole session (observed ~5-10s into a bookmarklet run). Fetching the
 * markup avoids booting anything, so the session survives.
 *
 * Trade-off vs. real navigation (CDP mode): server-rendered ("classic") pages
 * come back fully populated; `app/*` SPA routes return only their shell, so
 * their `.txt`/`.html` snapshots are thin. No data is lost — every clinical
 * fact is in the structured JSON; the dom phase is a convenience layer.
 */
export class FetchDom implements DomAccess {
  constructor(
    readonly origin: string,
    readonly prefix: string,
  ) {}

  private resolve(path: string): string {
    if (path.startsWith("http")) return path;
    if (path.startsWith("/")) return this.origin + path;
    return `${this.origin}${this.prefix}/${path}`;
  }

  async withSection<T>(
    path: string,
    _settleMs: number,
    fn: (page: SectionPage) => Promise<T>,
  ): Promise<T> {
    const url = this.resolve(path);
    const res = await fetch(url, { credentials: "include" });
    // A redirect to the login/logout surface means the session lapsed — make
    // it visible rather than silently snapshotting a login page.
    if (/\/(Authentication\/Login|bye\.asp)|action=logout/i.test(res.url)) {
      throw new Error(`section ${path} redirected to login (${res.url}) — session may have ended`);
    }
    const htmlText = await res.text();
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const page: SectionPage = {
      html: async () => doc.documentElement?.outerHTML ?? htmlText,
      // DOMParser documents aren't laid out, so innerText is empty; textContent
      // is the closest inert equivalent.
      text: async () => doc.body?.textContent ?? "",
      hrefs: async (selector: string) =>
        [...doc.querySelectorAll(selector)].map((a) => a.getAttribute("href")),
    };
    return fn(page);
  }
}
