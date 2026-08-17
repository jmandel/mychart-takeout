/**
 * Scan-first census: learn what the record contains — especially document
 * SIZES — before downloading any bodies, so the selection card can show real
 * numbers and flag outliers ("one file is 63 MB — include it?").
 *
 * Sizes come from headers alone: Epic's document list JSON carries no size
 * metadata, and its download endpoint ignores HEAD and Range — but the plain
 * download GET announces Content-Length, and fetch() resolves on headers, so
 * reading the header and cancelling the body costs a few KB per document
 * (verified against a production instance where this technique priced a 63 MB
 * scan without downloading it).
 */
import { extractAttachmentRef, isLoggedOutUrl, Mc } from "@mychart/core";
import { BrowserClient } from "./client";
import type { Resolved } from "./detect";
import { step } from "./journal";

export interface CensusDoc {
  dcsId: string;
  name: string;
  ext: string;
  /** Exact size from Content-Length, or null when the server didn't say. */
  bytes: number | null;
  /** Disproportionately large vs. the rest — gets its own opt-out row. */
  outlier: boolean;
}

/** A message attachment, priced the same way documents are — it lives in the
 *  same DCS store, so the same headers-only probe applies. */
export interface CensusAttachment extends CensusDoc {
  threadSubject: string;
  organizationId: string;
}

export interface Census {
  docs: CensusDoc[];
  /** Sum of the known document sizes. */
  knownBytes: number;
  /** Documents whose size could not be determined. */
  unknownCount: number;
  /** The LoadOtherDocuments payload — pre-seeded into the export's store so
   *  the documents phase works even when the structured phase is deselected. */
  listJson: unknown;
  /** Message attachments found by walking hasAttachments threads. */
  attachments: CensusAttachment[];
  /** Sum of the known attachment sizes. */
  attachmentBytes: number;
}

/**
 * An outlier is a file that would dominate the export: larger than 10× the
 * median known size AND at least 1 MB (so small exports don't flag ordinary
 * files). Mutates nothing; returns the flagged copy.
 */
export function flagOutliers<T extends CensusDoc>(docs: T[]): T[] {
  const known = docs.map((d) => d.bytes).filter((b): b is number => b !== null).sort((a, b) => a - b);
  if (known.length === 0) return docs.map((d) => ({ ...d, outlier: false }));
  // Lower-middle for even counts: with two files, the larger one must still be
  // comparable against the smaller, not against itself.
  const median = known[Math.floor((known.length - 1) / 2)]!;
  const threshold = Math.max(1024 * 1024, 10 * median);
  return docs.map((d) => ({ ...d, outlier: d.bytes !== null && d.bytes > threshold }));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Content-Length via headers-only GET: read headers, cancel the body. */
async function probeSize(url: string): Promise<number | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const r = await fetch(url, { credentials: "include", signal: ctl.signal });
    clearTimeout(timer);
    const len = r.headers.get("content-length");
    try {
      await r.body?.cancel();
    } catch {
      /* stream already closed */
    }
    if (isLoggedOutUrl(r.url) || r.status !== 200) return null;
    const n = Number(len);
    return len && Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Resolve a DCS token and price the blob from headers alone. */
async function probeDcs(
  resolved: Resolved,
  mc: Mc,
  dcsId: string,
  fileExtension: string,
  organizationId: string,
): Promise<number | null> {
  const det = await mc.api("api/documents/viewer/GetDocumentDetails", {
    dcsId,
    fileExtension,
    organizationId,
    useOldMobileLink: false,
  });
  const dj = rec(det.json);
  if (!str(dj.token)) return null;
  const q = new URLSearchParams({
    dcsId: str(dj.dcsId) || dcsId,
    token: str(dj.token),
    orgId: str(dj.orgId),
  });
  return probeSize(
    `${resolved.origin}${resolved.prefix}/Documents/ViewDocument/DownloadOrStream?${q}`,
  );
}

export async function runCensus(
  resolved: Resolved,
  onStatus: (s: string) => void,
): Promise<Census> {
  const client = new BrowserClient(resolved.origin, resolved.prefix);
  const mc = new Mc(client, undefined, { initialToken: resolved.token });
  step("== CENSUS ==");
  onStatus("Listing documents…");
  const list = await mc.api("api/documents/viewer/LoadOtherDocuments", { isInitialLoad: true });
  const listJson = list.json ?? { documents: [] };
  const raw = rec(listJson);
  const entries = Array.isArray(raw.documents) ? raw.documents : [];
  const docs: CensusDoc[] = [];
  let knownBytes = 0;
  let unknownCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const d = rec(entries[i]);
    const dcsId = str(d.dcsID) || str(d.docID);
    if (!dcsId) continue;
    onStatus(`Sizing documents ${i + 1}/${entries.length}…`);
    let bytes: number | null = null;
    try {
      bytes = await probeDcs(resolved, mc, dcsId, str(d.docExt) || "PDF", "");
    } catch {
      /* size stays unknown; the document is still selectable */
    }
    if (bytes === null) unknownCount++;
    else knownBytes += bytes;
    docs.push({
      dcsId,
      name: str(d.docDesc) || str(d.docType) || "document",
      ext: (str(d.docExt) || "PDF").toLowerCase(),
      bytes,
      outlier: false,
    });
  }

  // Message attachments: same DCS store, same pricing. Only threads the list
  // flags with hasAttachments are opened, so the cost scales with how many
  // attachment-bearing threads exist — and the census only runs on explicit
  // "scan first" request anyway.
  onStatus("Scanning messages for attachments…");
  const flagged: { hthId: string; organizationId: string; subject: string }[] = [];
  const seen = new Set<string>();
  for (const tag of [1, 2, 3, 4, 5, 6]) {
    try {
      const r = await mc.api("api/conversations/GetConversationList", {
        tag,
        localLoadParams: { loadStartInstantISO: "", loadEndInstantISO: "", numberToLoad: 9999 },
        externalLoadParams: {},
        searchQuery: "",
        PageNonce: "census",
      });
      const convs = rec(r.json).conversations;
      for (const c of Array.isArray(convs) ? convs : []) {
        const cc = rec(c);
        const id = str(cc.hthId) || (typeof cc.hthId === "number" ? String(cc.hthId) : "");
        if (!id || seen.has(id) || cc.hasAttachments !== true) continue;
        seen.add(id);
        flagged.push({ hthId: id, organizationId: str(cc.organizationId), subject: str(cc.subject) });
      }
    } catch {
      /* a failed tag just contributes nothing to the census */
    }
  }
  const attachments: CensusAttachment[] = [];
  let attachmentBytes = 0;
  for (let i = 0; i < flagged.length; i++) {
    const t = flagged[i]!;
    onStatus(`Sizing attachments ${i + 1}/${flagged.length}…`);
    try {
      const d = await mc.api("api/conversations/GetConversationDetails", {
        id: t.hthId,
        messageId: "",
        organizationId: t.organizationId,
        PageNonce: "census",
      });
      const dj = rec(d.json);
      const msgs = Array.isArray(dj.messages) ? dj.messages : Array.isArray(dj.messageList) ? dj.messageList : [];
      for (const m of msgs) {
        const mm = rec(m);
        for (const a of Array.isArray(mm.attachments) ? mm.attachments : []) {
          const ref = extractAttachmentRef(a);
          if (!ref) continue; // the export phase reports the shape-mismatch
          let bytes: number | null = null;
          try {
            bytes = await probeDcs(resolved, mc, ref.dcsId, ref.ext.toUpperCase(), t.organizationId);
          } catch {
            /* unknown size; still selectable */
          }
          if (bytes !== null) attachmentBytes += bytes;
          attachments.push({
            ...ref,
            bytes,
            outlier: false,
            threadSubject: t.subject,
            organizationId: t.organizationId,
          });
        }
      }
    } catch {
      /* skip thread; the export phase will still attempt it */
    }
  }

  step(`== CENSUS done: ${docs.length} docs + ${attachments.length} attachments ==`);
  // Outliers are judged across the COMBINED pool — "unusually large" should
  // mean relative to everything the export would fetch.
  const combined = flagOutliers<CensusDoc | CensusAttachment>([...docs, ...attachments]);
  return {
    docs: combined.slice(0, docs.length),
    knownBytes,
    unknownCount,
    listJson,
    attachments: combined.slice(docs.length) as CensusAttachment[],
    attachmentBytes,
  };
}
