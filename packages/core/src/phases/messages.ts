import type { PhaseCtx } from "../ctx";
import { DetailLoopGuard, topKeys } from "../heal";
import { isRecord, pad3, slug } from "../util";
import { fetchDcsBytes } from "./dcs";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

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
  for (const tag of [1, 2, 3, 4, 5, 6]) {
    const r = await ctx.mc.api("api/conversations/GetConversationList", {
      tag,
      localLoadParams: { loadStartInstantISO: "", loadEndInstantISO: "", numberToLoad: 9999 },
      externalLoadParams: {},
      searchQuery: "",
      PageNonce: ctx.nonce,
    });
    const j = r.json;
    if (j == null) {
      ctx.rec("messages", `GetConversationList[tag${tag}]`, r); // failed list → gaps
      continue;
    }
    await ctx.store.saveJson(`structured/messages/list_tag${tag}.json`, j);
    // A present-but-differently-shaped payload (no `conversations` array at
    // all) is an exporter gap, not "no messages" — say so.
    if (isRecord(j) && Object.keys(j).length > 0 && !Array.isArray(j.conversations)) {
      ctx.rec("messages", `GetConversationList[tag${tag}]`, r, `no conversations array (top keys: ${topKeys(j)})`, {
        outcome: "shape-mismatch",
      });
      continue;
    }
    const convs = isRecord(j) && Array.isArray(j.conversations) ? j.conversations : [];
    for (const c of convs) {
      if (!isRecord(c)) continue;
      const h =
        typeof c.hthId === "string" ? c.hthId : typeof c.hthId === "number" ? String(c.hthId) : "";
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
    ctx.rec("messages", `GetConversationList[tag${tag}]`, r, `${convs.length} convs`);
  }
  const index: Record<string, unknown>[] = [];
  const entries = [...conv.entries()];
  const guard = new DetailLoopGuard();
  let attTotal = 0;
  let attSavedTotal = 0;
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
      const r = await ctx.mc.api("api/conversations/GetConversationDetails", {
        id: h,
        messageId: "",
        organizationId: meta.organizationId,
        PageNonce: ctx.nonce,
      });
      const j = r.json;
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
        const dcsId = str(a.DocumentId) || str(a.dcsId) || str(a.dcsID) || str(a.documentId) || str(a.id);
        const display = str(a.FileDisplayName) || str(a.fileDisplayName) || str(a.name) || str(a.fileName) || "attachment";
        const ext = (
          str(a.FileExtensionWithoutDot) || str(a.fileExtension) || str(a.extension) ||
          (display.includes(".") ? display.split(".").pop()! : "bin")
        ).replace(/^\./, "").toLowerCase();
        if (!dcsId) {
          ctx.rec("messages", "attachments", null,
            `attachment without a recognizable document id (keys: ${topKeys(a)})`,
            { outcome: "shape-mismatch" });
          continue;
        }
        try {
          const { bytes } = await fetchDcsBytes(ctx, dcsId, ext.toUpperCase(), meta.organizationId);
          if (bytes) {
            const base = display.toLowerCase().endsWith(`.${ext}`)
              ? display.slice(0, -(ext.length + 1))
              : display;
            await ctx.store.saveBytes(
              `structured/messages/attachments/${name}_a${ai}_${slug(base, 40)}.${ext}`,
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
      `${attSavedTotal}/${attTotal} attachments downloaded`,
    );
  }
}
