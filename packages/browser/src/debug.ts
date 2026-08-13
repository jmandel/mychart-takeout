import { candidatePrefixes, discoverPrefixes, pageToken, resolveMyChart } from "./detect";

/**
 * A debug report for when detection fails on someone's MyChart, meant to be
 * reviewed and shared PRIVATELY with Josh (not posted publicly).
 *
 * It deliberately avoids the obvious PHI — no page text, no field values, no
 * cookie values, no query strings — but it still includes identifying context
 * (your health system's host, cookie names, etc.), so it is NOT for public
 * posting. It actively probes candidate path prefixes for a CSRF token and
 * inspects the page, so the output points at WHY MyChart wasn't found and what
 * prefix/token source would work instead.
 */

function redactUrl(u: string): string {
  try {
    const x = new URL(u, location.href);
    return x.origin + x.pathname + (x.search ? "?…" : "") + (x.hash ? "#…" : "");
  } catch {
    return "(unparseable)";
  }
}

function redactPath(p: string): string {
  // Mask any long opaque segment (ids/tokens/MRNs) but keep short route names.
  return p
    .split("/")
    .map((seg) => (seg.length > 24 || /^[A-Za-z0-9%._-]{20,}$/.test(seg) ? "…" : seg))
    .join("/");
}

interface Probe {
  prefix: string;
  status?: number;
  finalUrl?: string;
  contentType?: string | null;
  bodyLength?: number;
  bodyClass?: string; // empty | bare-token | html | json | other
  tokenFound?: boolean;
  looksLikeLogin?: boolean;
  inputNames?: string[];
  error?: string;
}

/** Classify the CSRF response body without leaking its value. */
function classifyBody(text: string): string {
  const t = text.trim();
  if (!t) return "empty";
  if (/^\s*[<]/.test(t)) return "html";
  if (/^\s*[{[]/.test(t)) return "json";
  if (t.length >= 16 && t.length <= 1024 && !/[<>{}"\s]/.test(t)) return "bare-token";
  return "other";
}

async function probe(prefix: string): Promise<Probe> {
  const url = `${location.origin}${prefix}/Home/CSRFToken`;
  try {
    const r = await fetch(url, { credentials: "include" });
    const text = await r.text();
    const tokenFound = /name="__RequestVerificationToken"[^>]*value="[^"]+"/.test(text);
    let inputNames: string[] = [];
    let title = "";
    try {
      const doc = new DOMParser().parseFromString(text, "text/html");
      inputNames = Array.from(doc.querySelectorAll("input[name]"))
        .map((i) => i.getAttribute("name") || "")
        .filter(Boolean)
        .slice(0, 25);
      title = (doc.title || "").toLowerCase();
    } catch {
      /* ignore parse errors */
    }
    return {
      prefix,
      status: r.status,
      finalUrl: redactUrl(r.url),
      contentType: r.headers.get("content-type"),
      bodyLength: text.length,
      bodyClass: classifyBody(text),
      tokenFound,
      looksLikeLogin: /login|sign in|log in|logout|saml|sso|authenticat/i.test(`${r.url} ${title}`),
      inputNames,
    };
  } catch (e) {
    return { prefix, error: String(e) };
  }
}

/** Build the report as pretty JSON text (ready to copy or download). */
export async function collectDebugReport(): Promise<string> {
  const inIframe = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();
  let frameDepth = 0;
  try {
    let w: Window = window;
    while (w.parent && w.parent !== w && frameDepth < 12) {
      frameDepth++;
      w = w.parent;
    }
  } catch {
    frameDepth = -1;
  }
  const ancestorOrigins = (() => {
    try {
      return Array.from((location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins ?? []);
    } catch {
      return [];
    }
  })();
  const referrerOrigin = (() => {
    try {
      return document.referrer ? new URL(document.referrer).origin : "";
    } catch {
      return "";
    }
  })();

  const candidates = candidatePrefixes();
  const probes: Probe[] = [];
  for (const p of candidates.slice(0, 10)) probes.push(await probe(p));

  const epicGlobals = (() => {
    try {
      return Object.keys(window)
        .filter((k) => /epic|mychart|wpr|__request|hydrat|_wp/i.test(k))
        .slice(0, 40);
    } catch {
      return [];
    }
  })();
  const cookieNames = document.cookie
    ? document.cookie.split(";").map((c) => c.split("=")[0]!.trim()).filter(Boolean)
    : [];
  const tokenInputsOnPage = document.querySelectorAll('input[name="__RequestVerificationToken"]').length;
  const iframes = Array.from(document.querySelectorAll("iframe"))
    .map((f) => redactUrl(f.getAttribute("src") || ""))
    .slice(0, 12);

  const report = {
    tool: "mychart-takeout debug report",
    note: "May include identifying details (your health system, cookie names). Review it, then share PRIVATELY with Josh — please don't post it publicly.",
    page: {
      origin: location.origin,
      host: location.host,
      pathname: redactPath(location.pathname),
      hasQuery: !!location.search,
      hasHash: !!location.hash,
      referrerOrigin,
    },
    framing: { inIframe, frameDepth, ancestorOrigins },
    detection: {
      firstPathSegment: location.pathname.split("/").filter(Boolean)[0] || "(none)",
      domDiscoveredPrefixes: discoverPrefixes(),
      candidatePrefixesTried: candidates,
      pageTokenFound: pageToken() !== null, // newer Epic: token embedded in page
      resolved: await resolveMyChart().then((r) => (r ? { prefix: r.prefix } : null)).catch(() => null),
    },
    csrfProbes: probes,
    signals: {
      requestVerificationTokenInputsOnPage: tokenInputsOnPage,
      epicGlobals,
      cookieNames,
      sameOriginIframes: iframes,
    },
  };
  return JSON.stringify(report, null, 2);
}
