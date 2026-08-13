import type { Mc } from "@mychart/core";
import type { CdpSession } from "./session";

/**
 * Proxy / multi-patient support for CDP mode.
 *
 * A MyChart login can hold "proxy" access to other people's charts (children,
 * dependents). Switching context is a server-side session change:
 *   enter a subject: inside.asp?mode=proxyswitch&action=switchcontext&eid=<eid>
 *   return to self:  inside.asp?mode=self        (NOT action=switchtoself,
 *                    which silently no-ops and strands you on the proxy)
 * After a switch, every API returns the ACTIVE subject's data. So a
 * proxy-aware export is: for each subject, switch → run phases → restore.
 *
 * Browser (bookmarklet) mode needs none of this — the user navigates to the
 * proxied record in the UI, then runs the bundle against the active context.
 */

export interface Subject {
  name: string;
  /** Encoded proxy id for switchcontext; empty for self. */
  eid: string;
  isSelf: boolean;
}

const SELF_URL = "inside.asp?mode=self";
const switchUrl = (eid: string) =>
  `inside.asp?mode=proxyswitch&action=switchcontext&src=0&eid=${eid}`;

/** Active patient's first name, via the health-summary endpoint. */
export async function activePatient(mc: Mc): Promise<string> {
  const r = await mc.api("api/health-summary/FetchHealthSummary", {});
  const j = r.json as { patientFirstName?: unknown } | undefined;
  return j && typeof j.patientFirstName === "string" ? j.patientFirstName : "";
}

/**
 * Enumerate accessible subjects from the home proxy menu. `self` is always
 * first; proxies come from the menu's switchcontext links.
 */
export async function discoverSubjects(session: CdpSession): Promise<Subject[]> {
  await session.page.goto(`${session.origin}${session.prefix}/Home/`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await session.page.waitForLoadState("networkidle", { timeout: 20000 });
  const raw = (await session.page.evaluate(
    `JSON.stringify({
       self: (document.querySelector('[title^="Currently accessing"] .proxySelectorDropDownNameEllipsis')||{}).textContent||"",
       links: [...document.querySelectorAll('a[href*="switchcontext"]')].map(a => ({
         href: a.getAttribute("href")||"",
         label: (a.getAttribute("aria-label")||a.textContent||"").replace(/\\s+/g," ").trim()
       }))
     })`,
  )) as string;
  return parseSubjects(raw);
}

/** Pure parser for the home proxy-menu JSON (self name + switchcontext links). */
export function parseSubjects(raw: string): Subject[] {
  let parsed: { self: string; links: { href: string; label: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { self: "", links: [] };
  }
  const seen = new Set<string>();
  const proxies: Subject[] = [];
  for (const l of parsed.links ?? []) {
    const eid = /eid=([^&]+)/.exec((l.href ?? "").replace(/&amp;/g, "&"))?.[1];
    if (!eid || seen.has(eid)) continue;
    seen.add(eid);
    // label like "Access Robin's record …" → first name
    const name = /access ([^']+?)'s record/i.exec(l.label ?? "")?.[1] ?? (l.label ?? "").split(/\s+/)[1] ?? "proxy";
    proxies.push({ name: name.trim(), eid, isSelf: false });
  }
  const selfName = (parsed.self || "self").trim();
  return [{ name: selfName, eid: "", isSelf: true }, ...proxies];
}

async function goURL(session: CdpSession, rel: string): Promise<void> {
  await session.page.goto(`${session.origin}${session.prefix}/${rel}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await session.page.waitForLoadState("networkidle", { timeout: 20000 });
}

/** Switch into a subject; verify the active patient matches. Returns success. */
export async function switchToSubject(session: CdpSession, mc: Mc, s: Subject): Promise<boolean> {
  if (s.isSelf) return true;
  await goURL(session, switchUrl(s.eid));
  const active = await activePatient(mc);
  return active.toLowerCase().startsWith(s.name.toLowerCase().slice(0, 3));
}

/** Restore to the account's own record. Returns success (verified). */
export async function switchToSelf(session: CdpSession, mc: Mc, selfName: string): Promise<boolean> {
  await goURL(session, SELF_URL);
  const active = await activePatient(mc);
  return active.toLowerCase().startsWith(selfName.toLowerCase().slice(0, 3));
}
