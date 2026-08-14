/**
 * Figure out WHERE MyChart lives on the current page. Different Epic sites use
 * different path prefixes (/MyChart, /MyChart-PRD, /MyChartPRD, or the app is
 * served at a non-obvious path), so instead of assuming the first URL segment
 * we probe candidate prefixes for a real CSRF token and use whichever works.
 * Shared by the on-load detection, the export run, and the debug report.
 */
import { isLoggedOutUrl } from "@mychart/core";
import { derivePrefix } from "./client";
import { step } from "./journal";

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
    step(`→ GET ${prefix}/Home/CSRFToken (detect)`);
    const r = await fetch(`${location.origin}${prefix}/Home/CSRFToken`, { credentials: "include" });
    step(`✓ ${r.status} ${prefix}/Home/CSRFToken (detect)`);
    if (!r.ok) return null;
    // A logged-out session redirects this to the LOGIN page, whose HTML also
    // contains a __RequestVerificationToken — don't be fooled into using it.
    if (isLoggedOutUrl(r.url)) return null;
    const body = await r.text();
    const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(body);
    if (m) return m[1]!;
    const t = body.trim();
    return t.length >= 16 && t.length <= 1024 && !/[<>{}"\s]/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Confirm a (prefix, token) actually authenticates by calling a real endpoint.
 * A logged-out session returns the login page (redirect-login) for everything,
 * so this is what distinguishes "signed in" from "stale page with a token".
 */
async function sessionIsLive(prefix: string, token: string): Promise<boolean> {
  try {
    step(`→ verify ${prefix}/api/health-summary/FetchHealthSummary`);
    const r = await fetch(`${location.origin}${prefix}/api/health-summary/FetchHealthSummary`, {
      method: "POST",
      credentials: "include",
      headers: {
        __RequestVerificationToken: token,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
      body: "{}",
    });
    const live = !isLoggedOutUrl(r.url) && /json/i.test(r.headers.get("content-type") || "");
    step(`✓ verify ${r.status} → ${live ? "SESSION LIVE" : "NOT AUTHENTICATED (login redirect)"}`);
    return live;
  } catch {
    return false;
  }
}

export interface Resolved {
  origin: string;
  prefix: string;
  token: string;
}

let memo: Resolved | null = null;

/**
 * Resolve the working MyChart origin+prefix and confirm the session is actually
 * authenticated. Returns null when it isn't (not on MyChart, OR signed out — a
 * stale page can still carry a token and every fetch just redirects to login).
 * The first live result is memoized so detection and the export agree.
 */
export async function resolveMyChart(): Promise<Resolved | null> {
  if (memo) return memo;
  if (/\/Authentication\/Login|action=logout/i.test(location.href)) return null;
  // Primary: probe candidate prefixes via /Home/CSRFToken. tokenAt already
  // rejects a login-page response, so a token here means a live session at that
  // prefix (older Epic returns the real token page only when authenticated).
  for (const prefix of candidatePrefixes()) {
    const token = await tokenAt(prefix);
    if (token) {
      memo = { origin: location.origin, prefix, token };
      return memo;
    }
  }
  // Fallback: newer Epic ("PX") serves no token at /Home/CSRFToken but embeds
  // it in the page — which a STALE (signed-out) page still has. So we must
  // verify the token authenticates a real API call before trusting it.
  const embedded = pageToken();
  if (embedded) {
    const prefix = derivePrefix(location.pathname);
    if (await sessionIsLive(prefix, embedded)) {
      memo = { origin: location.origin, prefix, token: embedded };
      return memo;
    }
  }
  return null;
}
