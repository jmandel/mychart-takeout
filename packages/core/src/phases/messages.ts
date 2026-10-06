import type { PhaseCtx } from "../ctx";
import { DetailLoopGuard, topKeys } from "../heal";
import { sweep } from "../paging";
import { isRecord, pad3, slug } from "../util";
import { extractAttachmentRef, fetchDcsBytes } from "./dcs";

interface ConvMeta {
  hthId: string;
  subject: string | null;
  tag: number;
  organizationId: string;
}

/** phase_messages: folder/org lists, per-tag conversation lists, full threads. */
export async function messages(ctx: PhaseCtx): Promise<void> {
  ctx.log("\n== messages: lists + full thread details ==");
  try {
    const f = await ctx.mc.api("api/conversations/GetFoldersList", {});
    await ctx.store.saveJson("structured/messages/folders.json", f.json ?? null);
    const o = await ctx.mc.api("api/conversations/GetOrganizations", {});
    await ctx.store.saveJson("structured/messages/organizations.json", o.json ?? null);
  } catch {
    // ignored (as in export.py)
  }
  const conv = new Map<string, ConvMeta>();
  for (const tag of folderTags(ctx.store.getJson("structured/messages/folders.json"))) {
    // A list pages by time: localSummary.hasMoreConversations + the oldest
    // instant loaded so far as the next window's end (see paging.ts).
    let firstShapeBad = false;
    const res = await sweep<Record<string, unknown>, string>({
      ctx,
      domain: "messages",
      endpoint: `GetConversationList[tag${tag}]`,
      first: "",
      recordComplete: false,
      fetchPage: async (loadEnd, page) => {
        const r = await ctx.mc.api("api/conversations/GetConversationList", {
          tag,
          localLoadParams: { loadStartInstantISO: "", loadEndInstantISO: loadEnd, numberToLoad: 9999 },
          externalLoadParams: {},
          searchQuery: "",
          PageNonce: ctx.nonce,
        });
        const j = r.json;
        if (j == null) {
          ctx.rec("messages", `GetConversationList[tag${tag}${page ? `,p${page + 1}` : ""}]`, r); // failed list → gaps
          return null;
        }
        await ctx.store.saveJson(`structured/messages/list_tag${tag}${page ? `_p${page + 1}` : ""}.json`, j);
        // A present-but-differently-shaped payload (no `conversations` array at
        // all) is an exporter gap, not "no messages" — say so.
        if (isRecord(j) && Object.keys(j).length > 0 && !Array.isArray(j.conversations)) {
          ctx.rec("messages", `GetConversationList[tag${tag}]`, r, `no conversations array (top keys: ${topKeys(j)})`, {
            outcome: "shape-mismatch",
          });
          if (page === 0) firstShapeBad = true;
          return null;
        }
        if (page === 0) {
          const n = isRecord(j) && Array.isArray(j.conversations) ? j.conversations.length : 0;
          ctx.rec("messages", `GetConversationList[tag${tag}]`, r, `${n} convs`);
        }
        return j;
      },
      parse: (j) => {
        if (!isRecord(j)) return null;
        const convs = (Array.isArray(j.conversations) ? j.conversations : []).filter(isRecord);
        const ls = isRecord(j.localSummary) ? j.localSummary : {};
        const oldest = typeof ls.oldestLoadedInstantISO === "string" && ls.oldestLoadedInstantISO ? ls.oldestLoadedInstantISO : undefined;
        return { items: convs, end: ls.hasMoreConversations !== true, next: oldest };
      },
      key: (c) => convId(c),
    });
    if (firstShapeBad) continue;
    for (const c of res.items) {
      const h = convId(c);
      if (h && !conv.has(h)) {
        conv.set(h, {
          hthId: h,
          subject: typeof c.subject === "string" ? c.subject : null,
          tag,
          organizationId:
            typeof c.organizationId === "string" && c.organizationId ? c.organizationId : "",
        });
      }
    }
  }
  const index: Record<string, unknown>[] = [];
  const entries = [...conv.entries()];
  const guard = new DetailLoopGuard();
  let attTotal = 0;
  let attSavedTotal = 0;
  let attExcluded = 0;
  for (let i = 0; i < entries.length; i++) {
    if (ctx.signal.aborted) break;
    if (guard.abandoned()) {
      ctx.rec(
        "messages",
        "GetConversationDetails",
        null,
        `abandoned after early consecutive failures; skipped remaining ${entries.length - i} threads`,
        { outcome: "skipped" },
      );
      break;
    }
    const [h, meta] = entries[i]!;
    try {
      // Without maxReadMessages the server returns only the newest 5 messages
      // (verified live: 5 of 7 saved, hasMoreMessages true).
      const r = await ctx.mc.api("api/conversations/GetConversationDetails", {
        id: h,
        messageId: "",
        organizationId: meta.organizationId,
        maxReadMessages: MAX_READ,
        PageNonce: ctx.nonce,
      });
      const j = isRecord(r.json) && r.json.hasMoreMessages === true
        ? await withOlderMessages(ctx, h, meta.organizationId, r.json)
        : r.json;
      if (j == null) {
        guard.fail();
        index.push({ ...meta, full_msgs: null });
        continue;
      }
      guard.ok();
      const name = `${pad3(i)}_${slug(meta.subject)}`;
      await ctx.store.saveJson(`structured/messages/threads_full/${name}.json`, {
        meta,
        detail: j,
      });
      const jr = isRecord(j) ? j : {};
      const msgs =
        Array.isArray(jr.messages) && jr.messages.length > 0
          ? jr.messages
          : Array.isArray(jr.messageList) && jr.messageList.length > 0
            ? jr.messageList
            : [];
      for (let mi = 0; mi < msgs.length; mi++) {
        const msg = isRecord(msgs[mi]) ? (msgs[mi] as Record<string, unknown>) : {};
        const body = typeof msg.body === "string" ? msg.body : "";
        if (body) {
          await ctx.store.saveText(
            `structured/messages/threads_full/${name}_m${mi}.html`,
            `<!-- ${meta.subject} | ${msg.deliveryInstantISO || msg.date} | author=${JSON.stringify(msg.author ?? null)} -->\n` +
              body,
          );
        }
      }
      // Attachments (e.g. device reports) are DCS documents — the messaging
      // UI's own viewer opens them through ViewDocument with the attachment's
      // DocumentId, so the documents download flow applies verbatim. Field
      // names are instance-observed best-effort: an attachment whose id we
      // can't find records a shape-mismatch naming its keys, so a field
      // report reveals the real shape even where the download can't run.
      const atts = msgs.flatMap((m) => (isRecord(m) && Array.isArray(m.attachments) ? m.attachments : []));
      let attSaved = 0;
      for (let ai = 0; ai < atts.length; ai++) {
        if (ctx.signal.aborted) break;
        const a = atts[ai];
        if (!isRecord(a)) continue;
        attTotal++;
        const ref = extractAttachmentRef(a);
        if (!ref) {
          ctx.rec("messages", "attachments", null,
            `attachment without a recognizable document id (keys: ${topKeys(a)})`,
            { outcome: "shape-mismatch" });
          continue;
        }
        // Attachments and documents share the DCS id namespace, so the
        // selection card's opt-outs apply to both.
        if (ctx.excludeDocIds?.has(ref.dcsId)) {
          attExcluded++;
          continue;
        }
        try {
          const { bytes } = await fetchDcsBytes(ctx, ref.dcsId, ref.ext.toUpperCase(), meta.organizationId);
          if (bytes) {
            await ctx.store.saveBytes(
              `structured/messages/attachments/${name}_a${ai}_${slug(ref.name, 40)}.${ref.ext}`,
              bytes,
            );
            attSaved++;
            attSavedTotal++;
          }
        } catch (e) {
          ctx.log(`   attachment err ${e}`);
        }
      }
      index.push({ ...meta, full_msgs: msgs.length, attachments: atts.length, attachments_saved: attSaved });
    } catch (e) {
      guard.fail();
      index.push({ ...meta, error: String(e) });
    }
  }
  await ctx.store.saveJson("structured/messages/_threads_full_index.json", index);
  const total = index.reduce((s, x) => s + ((x.full_msgs as number | null) || 0), 0);
  ctx.rec(
    "messages",
    "GetConversationDetails",
    { status: 200, body: "" },
    `${index.length} threads, ${total} messages`,
  );
  if (attTotal > 0) {
    ctx.rec(
      "messages",
      "attachments",
      { status: 200, body: "" },
      `${attSavedTotal}/${attTotal} attachments downloaded` +
        (attExcluded ? `, ${attExcluded} excluded by user` : ""),
    );
  }
}

const MAX_READ = 9999;

function convId(c: Record<string, unknown>): string {
  return typeof c.hthId === "string" ? c.hthId : typeof c.hthId === "number" ? String(c.hthId) : "";
}

/** Folder tags to list: 1–6 as always, plus every tag GetFoldersList reports
 *  (a live portal listed tag 7 with 16 conversations found in no other tag). */
export function folderTags(folders: unknown): number[] {
  const tags = new Set([1, 2, 3, 4, 5, 6]);
  const fs = isRecord(folders) && Array.isArray(folders.folders) ? folders.folders : [];
  for (const f of fs) if (isRecord(f) && typeof f.tag === "number" && Number.isInteger(f.tag)) tags.add(f.tag);
  return [...tags].sort((a, b) => a - b);
}

function deliveredAt(m: unknown): string {
  return isRecord(m) && typeof m.deliveryInstantISO === "string" ? m.deliveryInstantISO : "";
}

/**
 * A thread still reporting hasMoreMessages after GetConversationDetails: page
 * older messages the way the portal does — GetConversationMessages from the
 * oldest loaded message's instant — and merge them (deduped by wmgId), oldest
 * first as the details call returns them. Raw pages are kept in the result
 * under `_olderMessagePages`.
 */
async function withOlderMessages(
  ctx: PhaseCtx,
  id: string,
  organizationId: string,
  detail: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const first = Array.isArray(detail.messages) ? detail.messages : [];
  const oldest = first.map(deliveredAt).filter(Boolean).sort()[0] ?? "";
  const rawPages: unknown[] = [];
  const res = await sweep<unknown, string>({
    ctx,
    domain: "messages",
    endpoint: "GetConversationMessages",
    first: oldest,
    recordComplete: false,
    fetchPage: async (startInstantISO) => {
      const r = await ctx.mc.api("api/conversations/GetConversationMessages", {
        id,
        organizationId,
        startInstantISO,
        maxReadMessages: MAX_READ,
        PageNonce: ctx.nonce,
      });
      if (r.json != null) rawPages.push(r.json);
      return r.json ?? null;
    },
    parse: (j) => {
      if (!isRecord(j) || !Array.isArray(j.messages)) return null;
      const next = j.messages.map(deliveredAt).filter(Boolean).sort()[0];
      return { items: j.messages, end: j.hasMoreMessages !== true, next };
    },
    key: (m) => (isRecord(m) && typeof m.wmgId === "string" ? m.wmgId : JSON.stringify(m)),
  });
  const ids = new Set(first.map((m) => (isRecord(m) ? m.wmgId : undefined)));
  const older = res.items.filter((m) => !(isRecord(m) && ids.has(m.wmgId)));
  // The portal returns a thread oldest-first; keep that order.
  const merged = [...older, ...first].sort((a, b) => deliveredAt(a).localeCompare(deliveredAt(b)));
  return { ...detail, messages: merged, hasMoreMessages: !res.complete, _olderMessagePages: rawPages };
}
