/**
 * Records the SHAPE of same-origin API requests — both the MyChart app's own
 * and ours — so a debug report can compare how the app authenticates vs how we
 * do. This is the tool for "the app works but our fetches redirect to login":
 * if the app's successful requests carry a header (e.g. Authorization, or a
 * custom Epic header) that ours don't, that's the missing credential.
 *
 * Captures header NAMES only, never values (no tokens/PHI). We don't tag our
 * own requests (an unknown header could trip a WAF) — instead, in the failing
 * case the app's requests are the ones that SUCCEED (status 200, not logged
 * out) while ours all redirect to login, so status separates them.
 */
interface Captured {
  via: "fetch" | "xhr";
  method: string;
  path: string; // no query
  headerNames: string[];
  hasAuthorization: boolean;
  status?: number;
  loggedOut?: boolean;
}

const MAX = 60;
const captured: Captured[] = [];
let installed = false;

function pathOf(u: string): string {
  try {
    return new URL(u, location.href).pathname;
  } catch {
    return String(u).split("?")[0] || "";
  }
}
function apiish(p: string): boolean {
  return /\/(api|Clinical|Insurance|Documents|Demographics|Scheduling|Community|Authentication\/OAuth)\/|\/Home\/CSRFToken/i.test(p);
}
function headerNames(h: unknown): string[] {
  if (!h) return [];
  if (h instanceof Headers) return [...h.keys()];
  if (Array.isArray(h)) return h.map((e) => String((e as [string, string])[0]));
  if (typeof h === "object") return Object.keys(h as Record<string, unknown>);
  return [];
}
function push(rec: Captured): void {
  if (captured.length < MAX) captured.push(rec);
}

export function installNetCapture(): void {
  if (installed) return;
  installed = true;
  try {
    const origFetch = window.fetch.bind(window);
    const patchedFetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = "";
      let names: string[] = [];
      try {
        url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        names = headerNames(init?.headers);
        if (input instanceof Request) names = [...new Set([...names, ...headerNames(input.headers)])];
      } catch {
        /* ignore */
      }
      const p = pathOf(url);
      const promise = origFetch(input as RequestInfo, init);
      if (apiish(p)) {
        const rec: Captured = {
          via: "fetch",
          method: (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase(),
          path: p,
          headerNames: names,
          hasAuthorization: names.some((n) => /^authorization$/i.test(n)),
        };
        promise
          .then((r) => {
            rec.status = r.status;
            rec.loggedOut = /Authentication\/Login|action=logout|bye\.asp/i.test(r.url);
            push(rec);
          })
          .catch(() => push(rec));
      }
      return promise;
    };
    window.fetch = patchedFetch as unknown as typeof window.fetch;

    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSetHeader = XP.setRequestHeader;
    const origSend = XP.send;
    type Cap = { method: string; path: string; names: string[] };
    XP.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]): void {
      (this as unknown as { __mct?: Cap }).__mct = { method: (method || "GET").toUpperCase(), path: pathOf(url), names: [] };
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    };
    XP.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      (this as unknown as { __mct?: Cap }).__mct?.names.push(name);
      return origSetHeader.call(this, name, value);
    };
    XP.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      const c = (this as unknown as { __mct?: Cap }).__mct;
      if (c && apiish(c.path)) {
        this.addEventListener("loadend", () =>
          push({
            via: "xhr",
            method: c.method,
            path: c.path,
            headerNames: c.names,
            hasAuthorization: c.names.some((n) => /^authorization$/i.test(n)),
            status: this.status,
            loggedOut: /Authentication\/Login|action=logout|bye\.asp/i.test(this.responseURL || ""),
          }),
        );
      }
      return origSend.call(this, body ?? null);
    };
  } catch {
    /* best-effort; never break the page */
  }
}

export function capturedRequests(): Captured[] {
  return captured.slice(-MAX);
}
