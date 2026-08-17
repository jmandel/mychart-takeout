/**
 * The portal's document content store (DCS) — the flow behind
 * Documents/ViewDocument: resolve a per-document token, then stream bytes.
 * Shared by the documents phase and message attachments (the messaging UI's
 * own attachment viewer routes into the same ViewDocument module with the
 * attachment's DocumentId as the dcsId).
 */
import type { PhaseCtx } from "../ctx";
import { isRecord } from "../util";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface DcsFetch {
  /** The GetDocumentDetails response (or null when it wasn't JSON). */
  detail: unknown;
  /** The blob, or null when no token was issued / the download failed. */
  bytes: Uint8Array | null;
}

export async function fetchDcsBytes(
  ctx: PhaseCtx,
  dcsId: string,
  fileExtension: string,
  organizationId = "",
): Promise<DcsFetch> {
  const det = await ctx.mc.api("api/documents/viewer/GetDocumentDetails", {
    dcsId,
    fileExtension,
    organizationId,
    useOldMobileLink: false,
  });
  const dj = isRecord(det.json) ? det.json : null;
  const token = dj ? str(dj.token) : "";
  if (!token) return { detail: det.json ?? null, bytes: null };
  const q = new URLSearchParams({
    dcsId: (dj && str(dj.dcsId)) || dcsId,
    token,
    orgId: dj ? str(dj.orgId) : "",
  });
  const { status, bytes } = await ctx.client.fetchBytes(
    `${ctx.client.prefix}/Documents/ViewDocument/DownloadOrStream?${q.toString()}`,
  );
  return { detail: det.json ?? null, bytes: status === 200 && bytes.length > 0 ? bytes : null };
}
