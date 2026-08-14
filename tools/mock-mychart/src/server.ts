/**
 * Mock MyChart instance (synthetic data only) — CI target for the core phases
 * and the in-browser bundle. Serves the same route shapes the real portal
 * does: CSRF page, api/* JSON POSTs (token-checked), classic form/nobody
 * endpoints, paginated visit lists, report content, document downloads, and
 * the C-CDA package.
 *
 * It also impersonates the HOSTILE instances we hit in the field, via config
 * (see MockOpts): the login-token trap, the "PX" build whose token only lives
 * in the page, a live prefix alias behind a redirect chain, Epic's anti-CSRF
 * session kill, and an edge/WAF interstitial. Everything is one server so the
 * variants can be combined the way real instances combine them.
 *
 *   bun tools/mock-mychart/src/server.ts [--port N] [--prefix /MyChart-PRD]
 *        [--px] [--signed-out] [--alias /MyChart] [--kill-on-csrf-mismatch]
 *        [--stale-page-token] [--waf-challenge]
 */
import {
  CSRF_PAGE,
  CSRF_TOKEN,
  LOGIN_PAGE_TOKEN,
  WAF_CHALLENGE_PAGE,
  avsFor,
  buildCcdaZip,
  classicJson,
  conversationDetails,
  conversationList,
  docBytes,
  docToken,
  flowsheetReadings,
  loadPastPages,
  loadUpcoming,
  loginPage,
  openNotesFor,
  pageChrome,
  releaseRecords,
  sectionPage,
  simpleJson,
  testResultDetails,
  testResultsList,
  visitNotes,
} from "./data";

export interface MockOpts {
  port?: number;
  /** Path prefix the app is actually served at (default "/MyChart"). */
  prefix?: string;
  /**
   * "PX" build (newer Epic): /Home/CSRFToken NEVER yields a usable token — it
   * bounces to the login page whatever the session state — and the signed-in
   * page embeds the token instead, alongside PX window markers.
   */
  px?: boolean;
  /** Start with a live session (default true). false = signed out from t=0. */
  signedIn?: boolean;
  /**
   * A second, live prefix that reaches the same app through a redirect chain
   * of 2 hops including a case change (e.g. /MyChart → /mychartprd → /MyChartPRD).
   * POSTs sent there arrive as GETs (302 downgrades the method), which is how a
   * "working" alias silently turns an export into a pile of SPA shells.
   */
  aliasPrefix?: string;
  /** Prefix used by asset/nav links in served pages (default: the real one). */
  linkPrefix?: string;
  /**
   * Epic's anti-CSRF defense: an api/* POST carrying a wrong or missing
   * __RequestVerificationToken kills the session server-side. Afterwards
   * EVERY request — including the app's own — bounces to the login page.
   */
  killOnCsrfMismatch?: boolean;
  /** Embed a STALE token in every page BEFORE the live one (first-match trap). */
  stalePageToken?: boolean;
  /** Only the live session token authenticates. Defaults on for px / kill /
   *  stale-token instances; off otherwise so plain tests can send any token. */
  strictToken?: boolean;
  /** Serve an edge/WAF interstitial (NOT a login page) for api/* calls. */
  wafChallenge?: boolean;
}

/** Server-side truth about what the client did — the acceptance tests count
 *  requests HERE, so a tool cannot pass by lying about what it sent. */
export interface MockStats {
  /** POSTs to <prefix>/api/*, wherever they came from. */
  apiPosts: number;
  /** …of which carried a missing/stale/login-page/wrong token. */
  badTokenApiPosts: number;
  /** Pathnames of those POSTs, in order (prefix included). */
  apiPostPaths: string[];
  loginPagesServed: number;
  sessionAlive: boolean;
  /** The api/* path whose bad token killed the session, if any. */
  killedBy: string | null;
}

export interface MockServer {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  prefix: string;
  /** The live alias prefix, when configured. */
  alias: string | null;
  stats(): MockStats;
  /** Kill the session the way a logout/timeout would (stale-tab scenarios). */
  signOut(reason?: string): void;
  signIn(): void;
  stop(): void;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const html = (v: string, status = 200) =>
  new Response(v, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** Is `path` at or under `prefix`? (Exact case — an alias differing only in
 *  case is a DIFFERENT path, which is the whole point of the alias variant.) */
const under = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + "/");
const rest = (prefix: string, path: string) => path.slice(prefix.length);

type TokenGrade = "good" | "missing" | "login-page" | "wrong";

export function startMockMyChart(opts: MockOpts = {}): MockServer {
  const prefix = opts.prefix ?? "/MyChart";
  const alias = opts.aliasPrefix ?? null;
  const aliasHop = prefix.toLowerCase(); // middle hop of the alias chain
  const strict = opts.strictToken ?? !!(opts.px || opts.killOnCsrfMismatch || opts.stalePageToken);
  const chrome = pageChrome({
    px: opts.px,
    staleToken: opts.stalePageToken,
    linkPrefix: opts.linkPrefix ?? alias ?? undefined,
  });
  const ccdaZip = buildCcdaZip();

  const state = {
    alive: opts.signedIn !== false,
    killedBy: null as string | null,
    apiPosts: 0,
    badTokenApiPosts: 0,
    apiPostPaths: [] as string[],
    loginPagesServed: 0,
  };

  /** Every unauthenticated request lands here: 302 to the ~100KB login page. */
  const bounce = (url: URL) =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${prefix}/Authentication/Login?postloginurl=${encodeURIComponent(url.pathname + url.search)}`,
      },
    });
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  const grade = (tok: string | null): TokenGrade => {
    if (!tok) return "missing";
    if (tok === LOGIN_PAGE_TOKEN) return "login-page"; // never authenticates, anywhere
    if (strict && tok !== CSRF_TOKEN) return "wrong";
    return "good";
  };

  /** An app page, decorated with whatever chrome this variant implies. */
  const page = (body: string) => html(chrome ? body.replace("</body>", `${chrome}</body>`) : body);

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      // ---- live alias: 2 hops, including a case change, to the real prefix
      if (alias && under(alias, url.pathname)) {
        const next = aliasHop === alias ? prefix : aliasHop; // never redirect to self
        return redirect(next + rest(alias, url.pathname) + url.search);
      }
      if (alias && aliasHop !== prefix && under(aliasHop, url.pathname)) {
        return redirect(prefix + rest(aliasHop, url.pathname) + url.search);
      }

      if (!under(prefix, url.pathname)) return json({ error: "outside prefix" }, 404);
      const path = rest(prefix, url.pathname).replace(/^\//, "");
      const isPost = req.method === "POST";
      const isApi = path.startsWith("api/");
      const token = grade(req.headers.get("__RequestVerificationToken"));

      // ---- server-side accounting, before any behavior branches
      if (isPost && isApi) {
        state.apiPosts++;
        state.apiPostPaths.push(url.pathname);
        if (token !== "good") state.badTokenApiPosts++;
      }

      // ---- the login page itself is always reachable (it's what you get)
      if (/^Authentication\/Login/i.test(path)) {
        state.loginPagesServed++;
        return html(loginPage(url.searchParams.get("postloginurl") ?? ""));
      }

      // ---- dead session: EVERYTHING bounces, the app's own calls included
      if (!state.alive) return bounce(url);

      // ---- anti-CSRF: a bad token on api/* kills the session server-side
      if (isPost && isApi && token !== "good" && opts.killOnCsrfMismatch) {
        state.alive = false;
        state.killedBy = path;
        return bounce(url);
      }
      // ---- the login page's token authenticates nothing, on any instance
      if (isPost && token === "login-page") return bounce(url);

      // ---- edge/WAF interstitial in front of the JSON API (not a login page)
      if (isApi && opts.wafChallenge) return html(WAF_CHALLENGE_PAGE);

      // ---- unauthenticated-ish HTML routes
      if (path === "Home/CSRFToken") {
        // PX build: no usable token here, ever — it lives in the page instead.
        return opts.px ? bounce(url) : html(CSRF_PAGE);
      }
      if (path === "" || path === "Home") return page(sectionPage("home"));
      if (/^(scripts|styles|images|bundles|fonts)\//.test(path)) {
        const css = path.endsWith(".css");
        return new Response(css ? "/* mock */" : "/* mock */\n", {
          headers: { "content-type": css ? "text/css" : "text/javascript" },
        });
      }

      // ---- per-document content download (GET, binary, token-gated).
      // Sends Content-Length (a real Epic behavior the census flow relies on:
      // size is knowable from headers alone, before any body is read).
      if (path === "Documents/ViewDocument/DownloadOrStream") {
        const dcsId = url.searchParams.get("dcsId") ?? "";
        const bytes = docBytes(dcsId);
        if (!bytes || url.searchParams.get("token") !== docToken(dcsId)) {
          return json({ error: "bad dcsId/token" }, 400);
        }
        return new Response(bytes.slice().buffer as ArrayBuffer, {
          headers: {
            "content-type": dcsId.endsWith("A") ? "application/pdf" : "image/tiff",
            "content-length": String(bytes.length),
          },
        });
      }

      // ---- C-CDA package download (GET, binary)
      if (path === "Documents/Released/Download") {
        if (!url.searchParams.get("releaseId") || !url.searchParams.get("docId")) {
          return json({ error: "missing releaseId/docId" }, 400);
        }
        return new Response(ccdaZip.slice().buffer as ArrayBuffer, {
          headers: { "content-type": "application/zip" },
        });
      }

      // ---- everything below requires the CSRF header (verifies Mc wiring)
      if (isPost && token !== "good") {
        return json({ error: `${token} __RequestVerificationToken` }, 403);
      }
      // A GET at an api/* route is not an API call — real Epic answers with the
      // SPA shell. (This is what a POST downgraded by an alias redirect gets.)
      if (isApi && !isPost) return page(sectionPage("app-shell"));

      const body: Record<string, unknown> = await (async () => {
        if (!isPost) return {};
        try {
          const t = await req.text();
          return t && (req.headers.get("content-type") ?? "").includes("json")
            ? (JSON.parse(t) as Record<string, unknown>)
            : {};
        } catch {
          return {};
        }
      })();

      // ---- visits (POST, params in query string)
      if (path === "Visits/VisitsList/LoadUpcoming") return json(loadUpcoming);
      if (path === "Visits/VisitsList/LoadPast") {
        const sidx = url.searchParams.get("serializedIndex") ?? "";
        return json(loadPastPages[sidx] ?? {});
      }

      // ---- classic form/nobody endpoints (match on pathname, ignore query)
      if (path in classicJson) return json(classicJson[path]);

      // ---- api/* JSON endpoints
      if (path in simpleJson) return json(simpleJson[path]);
      if (path === "api/test-results/GetList") return json(testResultsList);
      if (path === "api/test-results/GetDetails") {
        const key = String(body.orderKey ?? "");
        return json(testResultDetails[key] ?? { error: `unknown order ${key}` });
      }
      if (path === "api/report-content/LoadReportContent") {
        const csn = String(body.csn ?? "");
        return body.reportMnemonic === "AMB_AVS" ? json(avsFor(csn)) : json(openNotesFor(csn));
      }
      if (path === "api/visit-notes/GetVisitNotes") {
        return json(visitNotes[String(body.CSN ?? "")] ?? { lrpID: "", noteList: [] });
      }
      if (path === "api/conversations/GetFoldersList") return json({ folders: [{ name: "Inbox" }] });
      if (path === "api/conversations/GetOrganizations") {
        return json({ organizations: [{ id: "ORG1", name: "Example Health" }] });
      }
      if (path === "api/conversations/GetConversationList") {
        return json(conversationList(Number(body.tag ?? 0)));
      }
      if (path === "api/conversations/GetConversationDetails") {
        return json(conversationDetails[String(body.id ?? "")] ?? { messages: [] });
      }
      if (path === "api/track-my-health/GetFlowsheetReadings") {
        return json(flowsheetReadings(String(body.endInstantIso ?? "")));
      }
      if (path === "api/requested-records/GetReleaseRecords") return json(releaseRecords);
      if (path === "api/record-download/GetDownloadStarted") return json({ started: true });
      if (path === "api/documents/viewer/GetDocumentDetails") {
        const dcsId = String(body.dcsId ?? "");
        if (!docBytes(dcsId)) return json({ error: `unknown document ${dcsId}` }, 404);
        return json({ dcsId, token: docToken(dcsId), orgId: "" });
      }

      return json({ error: `no mock route for ${path}` }, 404);
    },
  });

  return {
    server,
    prefix,
    alias,
    url: `http://localhost:${server.port}`,
    stats: () => ({
      apiPosts: state.apiPosts,
      badTokenApiPosts: state.badTokenApiPosts,
      apiPostPaths: [...state.apiPostPaths],
      loginPagesServed: state.loginPagesServed,
      sessionAlive: state.alive,
      killedBy: state.killedBy,
    }),
    signOut: (reason = "signOut()") => {
      state.alive = false;
      state.killedBy = state.killedBy ?? reason;
    },
    signIn: () => {
      state.alive = true;
      state.killedBy = null;
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string) => args.includes(flag);
  const mock = startMockMyChart({
    port: Number(get("--port") ?? 4599),
    prefix: get("--prefix") ?? "/MyChart",
    px: has("--px"),
    signedIn: !has("--signed-out"),
    aliasPrefix: get("--alias"),
    killOnCsrfMismatch: has("--kill-on-csrf-mismatch"),
    stalePageToken: has("--stale-page-token"),
    wafChallenge: has("--waf-challenge"),
  });
  console.log(`mock MyChart at ${mock.url}${mock.prefix}/Home`);
  if (mock.alias) console.log(`  live alias: ${mock.url}${mock.alias}/Home`);
}
