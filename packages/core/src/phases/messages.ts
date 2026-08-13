import type { PhaseCtx } from "../ctx";
import { isRecord, pad3, slug } from "../util";

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
    if (j == null) continue;
    await ctx.store.saveJson(`structured/messages/list_tag${tag}.json`, j);
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
  for (let i = 0; i < entries.length; i++) {
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
        index.push({ ...meta, full_msgs: null });
        continue;
      }
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
      index.push({ ...meta, full_msgs: msgs.length });
    } catch (e) {
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
}
