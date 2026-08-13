import type { PhaseCtx } from "../ctx";
import { isRecord, pad2, slug } from "../util";

/**
 * phase_documents: fetch the CONTENT of each document, not just the list.
 * The structured phase already saved the LoadOtherDocuments index; here we
 * walk it and, per document, resolve details + download the binary:
 *   GetDocumentDetails{dcsId, fileExtension} -> {dcsId, token, orgId, mimeType}
 *   GET Documents/ViewDocument/DownloadOrStream?dcsId=&token=&orgId=  -> bytes
 * (The detail response's own downloadUrl omits the token, so we build the URL.)
 *
 * Defensive throughout: unknown shapes, missing ids/tokens, or a failed
 * download skip that one document and never abort the export.
 */
const LIST_KEY = "structured/documents/documents__viewer__LoadOtherDocuments.json";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function documents(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== documents: per-document content ==");
  const list = ctx.store.getJson(LIST_KEY);
  const docs = isRecord(list) && Array.isArray(list.documents) ? list.documents : [];
  if (docs.length === 0) {
    ctx.rec("documents", "content", { status: 200, body: "" }, "no other-documents");
    return;
  }
  let files = 0;
  let details = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!isRecord(d)) continue;
    const dcsId = str(d.dcsID) || str(d.docID);
    if (!dcsId) continue;
    const ext = (str(d.docExt) || "PDF").toLowerCase();
    const name = `${pad2(i)}_${slug(str(d.docDesc) || str(d.docType) || "document", 50)}`;
    try {
      const det = await ctx.mc.api("api/documents/viewer/GetDocumentDetails", {
        dcsId,
        fileExtension: str(d.docExt) || "PDF",
        organizationId: "",
        useOldMobileLink: false,
      });
      const dj = det.json;
      await ctx.store.saveJson(`documents/other/${name}_detail.json`, {
        doc: d,
        detail: dj ?? { _raw: det.body },
      });
      details++;
      // Download the bytes only when we have the per-document token.
      if (isRecord(dj) && str(dj.token)) {
        const q = new URLSearchParams({
          dcsId: str(dj.dcsId) || dcsId,
          token: str(dj.token),
          orgId: str(dj.orgId),
        });
        const { status, bytes } = await ctx.client.fetchBytes(
          `${ctx.client.prefix}/Documents/ViewDocument/DownloadOrStream?${q.toString()}`,
        );
        if (status === 200 && bytes.length > 0) {
          await ctx.store.saveBytes(`documents/other/${name}.${ext}`, bytes);
          files++;
        }
      }
    } catch (e) {
      ctx.log(`  doc ${i} err ${e}`);
    }
  }
  ctx.rec(
    "documents",
    "content",
    { status: 200, body: "" },
    `${docs.length} docs, ${details} details, ${files} files downloaded`,
  );
}
