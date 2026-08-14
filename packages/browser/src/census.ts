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
import { isLoggedOutUrl, Mc } from "@mychart/core";
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

export interface Census {
  docs: CensusDoc[];
  /** Sum of the known document sizes. */
  knownBytes: number;
  /** Documents whose size could not be determined. */
  unknownCount: number;
  /** The LoadOtherDocuments payload — pre-seeded into the export's store so
   *  the documents phase works even when the structured phase is deselected. */
  listJson: unknown;
}

/**
 * An outlier is a file that would dominate the export: larger than 10× the
 * median known size AND at least 1 MB (so small exports don't flag ordinary
 * files). Mutates nothing; returns the flagged copy.
 */
export function flagOutliers(docs: CensusDoc[]): CensusDoc[] {
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
      const det = await mc.api("api/documents/viewer/GetDocumentDetails", {
        dcsId,
        fileExtension: str(d.docExt) || "PDF",
        organizationId: "",
        useOldMobileLink: false,
      });
      const dj = rec(det.json);
      if (str(dj.token)) {
        const q = new URLSearchParams({
          dcsId: str(dj.dcsId) || dcsId,
          token: str(dj.token),
          orgId: str(dj.orgId),
        });
        bytes = await probeSize(
          `${resolved.origin}${resolved.prefix}/Documents/ViewDocument/DownloadOrStream?${q}`,
        );
      }
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
  step(`== CENSUS done: ${docs.length} docs, ${knownBytes} known bytes ==`);
  return { docs: flagOutliers(docs), knownBytes, unknownCount, listJson };
}
