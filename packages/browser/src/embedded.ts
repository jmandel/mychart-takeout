/**
 * Verified wrapper portals whose embedded Epic app can be opened directly.
 * Inspect iframe src attributes only: no cross-origin DOM access or requests.
 * Keep this allowlist narrow until other portal handoffs have been verified.
 */
export function embeddedMyChartUrl(pageUrl: string, frameSources: readonly string[]): string | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.origin !== "https://myhealth.stanfordhealthcare.org" ||
      !page.pathname.startsWith("/signedin/")) return null;

  for (const src of frameSources) {
    try {
      const frame = new URL(src, page);
      if (frame.origin !== "https://mychart.stanfordhealthcare.org" ||
          frame.username || frame.password) continue;
      if (!/^\/myhealth_sso\/(?:inside\.asp|Home\/?)$/i.test(frame.pathname)) continue;
      // Use the verified home route, never copy SSO query parameters, hashes,
      // credentials, or patient-specific navigation from the iframe URL.
      return "https://mychart.stanfordhealthcare.org/myhealth_sso/Home/";
    } catch {
      // Ignore malformed iframe sources.
    }
  }
  return null;
}
