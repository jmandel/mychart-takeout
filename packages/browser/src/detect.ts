/**
 * Figure out WHERE MyChart lives on the current page. Different Epic sites use
 * different path prefixes (/MyChart, /MyChart-PRD, /MyChartPRD, or the app is
 * served at a non-obvious path), so instead of assuming the first URL segment
 * we probe candidate prefixes for a real CSRF token and use whichever works.
 * Shared by the on-load detection, the export run, and the debug report.
 */
import { derivePrefix } from "./client";

/** Prefixes implied by same-origin asset/link/form URLs already on the page. */
export function discoverPrefixes(): string[] {
  const out = new Set<string>();
  const urls: string[] = [];
  const push = (v: string | null) => v && urls.push(v);
  for (const s of Array.from(document.querySelectorAll("script[src]"))) push(s.getAttribute("src"));
  for (const l of Array.from(document.querySelectorAll("link[href]"))) push(l.getAttribute("href"));
  for (const a of Array.from(document.querySelectorAll("a[href]"))) push(a.getAttribute("href"));
  for (const f of Array.from(document.querySelectorAll("form[action]"))) push(f.getAttribute("action"));
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw, location.href);
    } catch {
      continue;
    }
    if (u.origin !== location.origin) continue;
    // MyChart assets/routes live under <prefix>/(scripts|en-US|Home|api|...)/
    const asset = /^(\/[^?#]*?)\/(scripts|en-us|en-US|Home|images|styles|bundles|fonts|api)\//.exec(u.pathname);
    if (asset) out.add(asset[1] || "");
    const csrf = /^(\/[^?#]*?)\/Home\/CSRFToken/i.exec(u.pathname);
    if (csrf) out.add(csrf[1] || "");
  }
  return [...out];
}

/** Ordered, de-duped list of prefixes worth probing on this page. */
export function candidatePrefixes(): string[] {
  const first = location.pathname.split("/").filter(Boolean)[0];
  const list = [
    ...(first ? ["/" + first] : []),
    ...discoverPrefixes(),
    "/MyChart",
    "/MyChart-PRD",
    "/MyChartPRD",
    "/mychart",
    "/EpicMyChart",
    "", // app served at the origin root
  ];
  return [...new Set(list)];
}

/** The __RequestVerificationToken embedded in the current page, if present.
 *  Newer Epic ("PX") builds don't return it from /Home/CSRFToken. */
export function pageToken(): string | null {
  const el = document.querySelector('input[name="__RequestVerificationToken"]');
  const v = el instanceof HTMLInputElement ? el.value : "";
  return v || null;
}

/** Token from /Home/CSRFToken at a prefix (hidden input or bare body), else null. */
export async function tokenAt(prefix: string): Promise<string | null> {
  try {
    const r = await fetch(`${location.origin}${prefix}/Home/CSRFToken`, { credentials: "include" });
    if (!r.ok) return null;
    const body = await r.text();
    const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(body);
    if (m) return m[1]!;
    const t = body.trim();
    return t.length >= 16 && t.length <= 1024 && !/[<>{}"\s]/.test(t) ? t : null;
  } catch {
    return null;
  }
}

export interface Resolved {
  origin: string;
  prefix: string;
  token: string;
}

let memo: Resolved | null = null;

/**
 * Resolve the working MyChart origin+prefix by probing candidates for a CSRF
 * token. Returns null when none yields one (not a signed-in MyChart page).
 * The first success is memoized so detection and the export agree.
 */
export async function resolveMyChart(): Promise<Resolved | null> {
  if (memo) return memo;
  if (/\/Authentication\/Login|action=logout/i.test(location.href)) return null;
  // Primary: probe candidate prefixes via /Home/CSRFToken (unchanged for the
  // older Epic builds this already worked on).
  for (const prefix of candidatePrefixes()) {
    const token = await tokenAt(prefix);
    if (token) {
      memo = { origin: location.origin, prefix, token };
      return memo;
    }
  }
  // Fallback: newer Epic ("PX") serves no token at /Home/CSRFToken but embeds
  // it in the page. If it's there, we ARE on MyChart — use it + the derived
  // prefix (the app is loaded at that path).
  const embedded = pageToken();
  if (embedded) {
    memo = { origin: location.origin, prefix: derivePrefix(location.pathname), token: embedded };
    return memo;
  }
  return null;
}
