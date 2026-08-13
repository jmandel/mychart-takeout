/**
 * Mock MyChart instance (synthetic data only) — CI target for the core phases
 * and the in-browser bundle. Serves the same route shapes the real portal
 * does: CSRF page, api/* JSON POSTs (token-checked), classic form/nobody
 * endpoints, paginated visit lists, report content, C-CDA download, and HTML
 * section pages for iframe/dom snapshots.
 *
 *   bun tools/mock-mychart/src/server.ts [--port N] [--prefix /MyChart-PRD]
 */
import { SECTIONS } from "@mychart/core";
import {
  CSRF_PAGE,
  avsFor,
  buildCcdaZip,
  classicJson,
  conversationDetails,
  conversationList,
  flowsheetReadings,
  loadPastPages,
  loadUpcoming,
  openNotesFor,
  releaseRecords,
  sectionPage,
  simpleJson,
  testResultDetails,
  testResultsAppPage,
  testResultsList,
  visitNotes,
} from "./data";

export interface MockOpts {
  port?: number;
  prefix?: string;
}

export interface MockServer {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  prefix: string;
  stop(): void;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const html = (v: string) =>
  new Response(v, { headers: { "content-type": "text/html; charset=utf-8" } });

export function startMockMyChart(opts: MockOpts = {}): MockServer {
  const prefix = opts.prefix ?? "/MyChart";
  const ccdaZip = buildCcdaZip();

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) {
        return json({ error: "outside prefix" }, 404);
      }
      const path = url.pathname.slice(prefix.length).replace(/^\//, "");

      // ---- unauthenticated-ish HTML routes
      if (path === "Home/CSRFToken") return html(CSRF_PAGE);
      if (path === "" || path === "Home") return html(sectionPage("home"));
      if (path === "app/test-results") return html(testResultsAppPage);

      // ---- C-CDA package download (GET, binary)
      if (path === "Documents/Released/Download") {
        if (!url.searchParams.get("releaseId") || !url.searchParams.get("docId")) {
          return json({ error: "missing releaseId/docId" }, 400);
        }
        return new Response(ccdaZip.slice().buffer as ArrayBuffer, {
          headers: { "content-type": "application/zip" },
        });
      }

      // ---- section pages (dom phase iframes)
      const section = SECTIONS.find(([, p]) => p === path);
      if (section && req.method === "GET") return html(sectionPage(section[0]));

      // ---- everything below requires the CSRF header (verifies Mc wiring)
      if (req.method === "POST" && !req.headers.get("__RequestVerificationToken")) {
        return json({ error: "missing __RequestVerificationToken" }, 403);
      }

      const body: Record<string, unknown> = await (async () => {
        if (req.method !== "POST") return {};
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

      return json({ error: `no mock route for ${path}` }, 404);
    },
  });

  return {
    server,
    prefix,
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mock = startMockMyChart({
    port: Number(get("--port") ?? 4599),
    prefix: get("--prefix") ?? "/MyChart",
  });
  console.log(`mock MyChart at ${mock.url}${mock.prefix}/Home`);
}
