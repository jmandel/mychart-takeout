import type { PhaseCtx } from "../ctx";
import { isRecord, pad2, slug } from "../util";
import { fetchDcsBytes } from "./dcs";

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
/** Where the structured phase saves the documents index — exported so the
 *  census flow can pre-seed it when the structured phase is deselected. */
export const OTHER_DOCUMENTS_LIST_KEY =
  "structured/documents/documents__viewer__LoadOtherDocuments.json";
const LIST_KEY = OTHER_DOCUMENTS_LIST_KEY;

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
  let excluded = 0;
  for (let i = 0; i < docs.length; i++) {
    if (ctx.signal.aborted) break;
    const d = docs[i];
    if (!isRecord(d)) continue;
    const dcsId = str(d.dcsID) || str(d.docID);
    if (!dcsId) continue;
    if (ctx.excludeDocIds?.has(dcsId)) {
      excluded++;
      continue;
    }
    const ext = (str(d.docExt) || "PDF").toLowerCase();
    const name = `${pad2(i)}_${slug(str(d.docDesc) || str(d.docType) || "document", 50)}`;
    try {
      const { detail, bytes } = await fetchDcsBytes(ctx, dcsId, str(d.docExt) || "PDF");
      await ctx.store.saveJson(`documents/other/${name}_detail.json`, {
        doc: d,
        // A non-JSON detail response is a failure page — never embed it.
        detail: detail ?? { _unavailable: true },
      });
      details++;
      if (bytes) {
        await ctx.store.saveBytes(`documents/other/${name}.${ext}`, bytes);
        files++;
      }
    } catch (e) {
      ctx.log(`  doc ${i} err ${e}`);
    }
  }
  ctx.rec(
    "documents",
    "content",
    { status: 200, body: "" },
    `${docs.length} docs, ${details} details, ${files} files downloaded` +
      (excluded ? `, ${excluded} excluded by user` : ""),
  );
}
