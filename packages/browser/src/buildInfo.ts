/**
 * Build stamp injected by the bundler (apps/web-build). Bookmarklets are
 * frozen at install time — the whole bundle lives in the javascript: URL, and
 * the portals' CSP (script-src 'self') forbids a loader — so every overlay,
 * debug report, and export must say WHICH build produced it, or remote
 * debugging degenerates into deploy-time forensics.
 */
declare const __MCT_BUILD__: string | undefined;

export const BUILD: string = typeof __MCT_BUILD__ !== "undefined" ? __MCT_BUILD__ : "dev";
