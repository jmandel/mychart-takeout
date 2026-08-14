/**
 * Figure out WHERE MyChart lives on the current page and WHICH credential
 * authenticates API calls — with verify-before-trust, because the field
 * taught us three hard rules:
 *
 *  1. /Home/CSRFToken serves the LOGIN page (which itself contains a
 *     __RequestVerificationToken!) to signed-out sessions on every Epic
 *     generation — a parseable token proves nothing by itself.
 *  2. A (prefix, token) that LOOKS right can still fail API calls: aliased
 *     prefixes (/MyChart redirecting into /mychartprd) and newer "PX" builds
 *     hand out tokens that don't authenticate where we POST them.
 *  3. A wrong-token POST is DESTRUCTIVE: Epic's anti-CSRF defense can kill
 *     the live session, signing the user out of their own portal.
 *
 * So resolution is a ladder: a cookie-liveness GET first (a signed-out page
 * never receives any POST), then candidates ordered most-likely-first (on PX
 * pages the page-embedded token at the page's own prefix; on classic the
 * CSRFToken endpoint), each VERIFIED by a real API call before adoption, with
 * a hard budget on verification POSTs. Every rung is recorded for the debug
 * report, so a failed detection shows its whole decision tree.
 */
import { isLoggedOutUrl, looksLikeLoginPage } from "@mychart/core";
import { derivePrefix } from "./client";
import { step } from "./journal";

/** Max verification POSTs per resolution — each carries session-kill risk. */
const MAX_VERIFY_POSTS = 2;

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

/** Newer Epic "PX" front-end markers — when present, the page-embedded token
 *  at the page's own prefix is the most likely credential, so it's tried first. */
export function pxMarkers(): boolean {
  try {
    if ("EpicPx" in window) return true;
    return Object.keys(window).some((k) => k.startsWith("webpackChunk_epic_px"));
  } catch {
    return false;
  }
}

/** Token from /Home/CSRFToken at a prefix (hidden input or bare body), else null. */
export async function tokenAt(prefix: string): Promise<string | null> {
  try {
    step(`→ GET ${prefix}/Home/CSRFToken (detect)`);
    const r = await fetch(`${location.origin}${prefix}/Home/CSRFToken`, { credentials: "include" });
    step(`✓ ${r.status} ${prefix}/Home/CSRFToken (detect)`);
    if (!r.ok) return null;
    // A logged-out session redirects (or rewrites, on some instances) this to
    // the LOGIN page, whose HTML also contains a __RequestVerificationToken —
    // don't be fooled into using it. Check the URL and the content.
    if (isLoggedOutUrl(r.url)) return null;
    const body = await r.text();
    if (looksLikeLoginPage(body)) return null;
    const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(body);
    if (m) return m[1]!;
    const t = body.trim();
    return t.length >= 16 && t.length <= 1024 && !/[<>{}"\s]/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Cookie-liveness without any POST: re-GET the current page's own path and see
 * whether it bounces to login. Signed-out sessions fail here, so they never
 * receive a token-bearing POST at all (which could otherwise kill nothing —
 * but on a live-but-mismatched session, POSTs are the dangerous part).
 * Network trouble returns true (unknown) — verification will catch it.
 */
export async function cookiesAreLive(): Promise<boolean> {
  try {
    step(`→ GET ${location.pathname} (liveness)`);
    const r = await fetch(location.origin + location.pathname, { credentials: "include" });
    const live = !isLoggedOutUrl(r.url) && !looksLikeLoginPage(await r.text());
    step(`✓ ${r.status} liveness → ${live ? "SIGNED IN" : "SIGNED OUT (login redirect)"}`);
    rung({ step: "liveness", outcome: live ? "live" : "signed-out" });
    return live;
  } catch (e) {
    step(`✗ liveness probe failed (${e}) — proceeding to verification`);
    rung({ step: "liveness", outcome: "unreachable" });
    return true;
  }
}

/**
 * Confirm a (prefix, token) actually authenticates by calling a real endpoint.
 * A logged-out or mismatched session returns the login page for everything,
 * so this is what distinguishes "works" from "looks right".
 */
async function verify(prefix: string, token: string): Promise<boolean> {
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
    step(`✓ verify ${r.status} → ${live ? "AUTHENTICATED" : "NOT AUTHENTICATED (login redirect)"}`);
    return live;
  } catch {
    return false;
  }
}

export type TokenSource = "page-token" | "csrf-endpoint";

export interface LadderRung {
  step: "liveness" | "candidate" | "budget";
  prefix?: string;
  source?: TokenSource;
  outcome: string; // live | signed-out | unreachable | no-token | verified | verify-failed | not-tried
}

export interface Resolved {
  origin: string;
  prefix: string;
  token: string;
  /** Where the working token came from — PX pages embed it, classic serves it. */
  source: TokenSource;
}

let ladder: LadderRung[] = [];
function rung(r: LadderRung): void {
  ladder.push(r);
}
/** The full decision tree of the last resolution, for the debug report. */
export function ladderTranscript(): LadderRung[] {
  return ladder.slice();
}

let memo: Resolved | null = null;

/** The already-verified resolution, if any — never triggers network activity.
 *  The debug report uses this so clicking Debug can't fire risky POSTs. */
export function resolvedMyChart(): Resolved | null {
  return memo;
}

export type Preflight = "likely" | "signed-out" | "no-mychart";

/**
 * GET-only page-load gate: is this a signed-in MyChart page at all? Reveals
 * the Start button without sending a single POST — verification (which risks
 * killing a mismatched session via Epic's anti-CSRF defense) is deferred to
 * the user's explicit Start click, so merely loading the tool is harmless.
 */
export async function preflightMyChart(): Promise<Preflight> {
  if (/\/Authentication\/Login|action=logout/i.test(location.href)) return "signed-out";
  if (!(await cookiesAreLive())) return "signed-out";
  if (pageToken()) return "likely";
  for (const prefix of candidatePrefixes()) {
    if (await tokenAt(prefix)) return "likely";
  }
  return "no-mychart";
}

/**
 * Resolve the working MyChart origin+prefix+token, confirming BOTH that the
 * session is live and that the token authenticates a real API call. Returns
 * null when it can't (wrong page, signed out, or no candidate verifies).
 * The first verified result is memoized so detection and the export agree.
 */
export async function resolveMyChart(): Promise<Resolved | null> {
  if (memo) return memo;
  ladder = [];
  if (/\/Authentication\/Login|action=logout/i.test(location.href)) {
    rung({ step: "liveness", outcome: "on-login-page" });
    return null;
  }
  if (!(await cookiesAreLive())) return null;

  // Candidates, most-likely-first. Each verification POST risks killing a
  // mismatched session, so ordering is not an optimization — it's safety.
  interface Candidate {
    prefix: string;
    source: TokenSource;
    token?: string;
  }
  const pagePrefix = derivePrefix(location.pathname);
  const embedded = pageToken();
  const pageCand: Candidate | null = embedded
    ? { prefix: pagePrefix, source: "page-token", token: embedded }
    : null;
  const candidates: Candidate[] = [];
  const px = pxMarkers();
  if (px && pageCand) candidates.push(pageCand);
  for (const prefix of candidatePrefixes()) candidates.push({ prefix, source: "csrf-endpoint" });
  if (!px && pageCand) candidates.push(pageCand);

  let verifyPosts = 0;
  for (const cand of candidates) {
    if (verifyPosts >= MAX_VERIFY_POSTS) {
      rung({ step: "budget", prefix: cand.prefix, source: cand.source, outcome: "not-tried" });
      continue;
    }
    const token = cand.token ?? (await tokenAt(cand.prefix));
    if (!token) {
      rung({ step: "candidate", prefix: cand.prefix, source: cand.source, outcome: "no-token" });
      continue;
    }
    verifyPosts++;
    const ok = await verify(cand.prefix, token);
    rung({
      step: "candidate",
      prefix: cand.prefix,
      source: cand.source,
      outcome: ok ? "verified" : "verify-failed",
    });
    if (ok) {
      memo = { origin: location.origin, prefix: cand.prefix, token, source: cand.source };
      return memo;
    }
  }
  return null;
}
