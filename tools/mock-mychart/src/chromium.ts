import { existsSync } from "node:fs";

/**
 * Resolve a Chromium/Chrome executable for the headless e2e tests. Honors
 * $CHROMIUM_PATH / $CHROME_PATH / $PUPPETEER_EXECUTABLE_PATH, then tries common
 * locations. Returns null when none is found so tests can skip (e.g. CI without
 * a browser) instead of failing.
 */
export function findChromium(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
