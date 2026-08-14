/**
 * Progress overlay for the in-page exporter — a four-state machine, not a
 * growing panel. Each state owns ONE primary action and one status line:
 *
 *   checking → ready → busy → done | failed        (+ select, via "scan first")
 *
 * Anti-accretion rules this file encodes: nothing is always-visible except
 * the title bar and the footer (details-toggle · byte counter · Debug); every
 * new capability must live inside a state or inside the collapsed details
 * drawer (where the request log goes — it's developer exhaust, not UI); copy
 * budget is one sentence per status, two for errors.
 */
import { BUILD } from "./buildInfo";
import type { Census } from "./census";
import { fmtBytes, onProgress } from "./progress";

const OVERLAY_ID = "__mychart_export_overlay";

/** Design tokens — the whole visual system. Change here or not at all. */
const T = {
  bg: "#111827",
  panel: "#1f2937",
  line: "#374151",
  ink: "#e5e7eb",
  mut: "rgba(229,231,235,.65)",
  dim: "rgba(229,231,235,.45)",
  accent: "#2563eb",
  good: "#059669",
  bad: "#7f1d1d",
  badLine: "#b91c1c",
  font: "12px/1.5 ui-monospace,Menlo,monospace",
};

export interface ReadyActions {
  onExportAll(): void;
  onScanFirst(): void;
}

/** What the user picked on the selection card. */
export interface Selection {
  clinical: boolean;
  messages: boolean;
  documents: boolean;
  dom: boolean;
  excludeDocIds: string[];
}

export interface Overlay {
  root: HTMLElement;
  /** Goes to the collapsed details drawer, never the main surface. */
  log(line: string): void;
  setChecking(msg: string): void;
  setReady(actions: ReadyActions): void;
  /** One-line status; safe to call repeatedly (updates in place). */
  setBusy(status: string): void;
  setSelect(census: Census, onExport: (sel: Selection) => void): void;
  setDone(zip: Uint8Array, filename?: string): void;
  setFailed(message: string): void;
  onDebug(fn: () => Promise<string>): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, bg: string, fg = "#fff"): HTMLButtonElement {
  const b = el(
    "button",
    `background:${bg};color:${fg};border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;`,
    label,
  );
  return b;
}

function linkButton(label: string): HTMLButtonElement {
  return el(
    "button",
    `background:transparent;color:${T.mut};border:0;padding:2px 0;cursor:pointer;font:inherit;text-decoration:underline;text-underline-offset:2px;`,
    label,
  );
}

/** Create (or return the existing) overlay panel. Idempotent across re-pastes. */
export function ensureOverlay(): Overlay {
  const existingHost = document.getElementById(OVERLAY_ID) as
    | (HTMLElement & { __overlay?: Overlay })
    | null;
  if (existingHost?.__overlay) return existingHost.__overlay;
  existingHost?.remove();

  // The panel lives inside a SHADOW ROOT: the host page's stylesheets cannot
  // cross the boundary, so MyChart's own global CSS (label/input/span rules)
  // can't distort the overlay — observed in the field as staircase-indented,
  // narrow-wrapped rows. Inheritance still crosses, so the panel pins font and
  // color explicitly. All styling stays CSSOM (.style.cssText), which strict
  // CSP style-src policies don't block (a <style> tag might be).
  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const root = el(
    "div",
    `position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;max-height:70vh;` +
      `background:${T.bg};color:${T.ink};font:${T.font};border:1px solid ${T.line};` +
      `border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;` +
      `text-align:left;letter-spacing:normal;box-sizing:border-box;`,
  );

  // ---- title bar (permanent)
  const title = el(
    "div",
    `padding:8px 12px;font-weight:700;background:${T.panel};border-bottom:1px solid ${T.line};display:flex;align-items:center;gap:8px;`,
  );
  title.appendChild(el("span", "", "MyChart Export"));
  const ver = el("span", `opacity:.5;font-weight:400;font-size:10px;flex:1;`, BUILD);
  ver.title = "Build (git SHA + build time). A bookmarklet keeps its install-time build.";
  title.appendChild(ver);
  const closeBtn = el(
    "button",
    `background:transparent;color:${T.mut};border:0;font:inherit;font-size:14px;line-height:1;cursor:pointer;padding:0 4px;`,
    "✕",
  );
  closeBtn.title = "Close (does not cancel a download already saved)";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => host.remove());
  title.appendChild(closeBtn);
  root.appendChild(title);

  // ---- state-owned content region (scrolls when a state outgrows the panel —
  // a long selection card must never clip unreachably)
  const content = el(
    "div",
    "padding:12px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;flex:1;min-height:0;",
  );
  root.appendChild(content);

  // ---- footer (permanent): details toggle · byte counter · Debug
  const footer = el(
    "div",
    `padding:6px 12px;border-top:1px solid ${T.line};display:flex;align-items:center;gap:10px;`,
  );
  const toggle = el(
    "button",
    `background:transparent;color:${T.dim};border:0;cursor:pointer;font:inherit;font-size:11px;padding:0;`,
    "▸ details",
  );
  footer.appendChild(toggle);
  const counter = el("span", `opacity:.65;font-size:11px;white-space:nowrap;margin-left:auto;`);
  footer.appendChild(counter);
  const debugBtn = el(
    "button",
    `background:${T.line};color:${T.ink};border:0;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;`,
    "Debug",
  );
  debugBtn.title = "Collect a debug report to review and share privately with Josh";
  footer.appendChild(debugBtn);
  root.appendChild(footer);

  // ---- collapsed details drawer: request log + copyable report area
  const drawer = el(
    "div",
    `display:none;flex-direction:column;border-top:1px solid ${T.line};max-height:180px;`,
  );
  const logBox = el("div", "padding:8px 12px;overflow-y:auto;white-space:pre-wrap;font-size:11px;opacity:.8;");
  drawer.appendChild(logBox);
  root.appendChild(drawer);
  shadow.appendChild(root);
  document.body.appendChild(host);

  let drawerOpen = false;
  const setDrawer = (open: boolean): void => {
    drawerOpen = open;
    drawer.style.display = open ? "flex" : "none";
    toggle.textContent = open ? "▾ details" : "▸ details";
  };
  toggle.addEventListener("click", () => setDrawer(!drawerOpen));

  onProgress((bytes, requests) => {
    counter.textContent = requests > 0 ? `${fmtBytes(bytes)} · ${requests} req` : "";
  });

  // ---- state rendering
  let state = "";
  let busyLine: HTMLElement | null = null;
  const render = (name: string, ...children: HTMLElement[]): void => {
    state = name;
    busyLine = null;
    content.replaceChildren(...children);
  };
  const statusLine = (text: string, color = T.mut): HTMLElement =>
    el("div", `color:${color};`, text);

  const dismissRow = (...extra: HTMLElement[]): HTMLElement => {
    const row = el("div", "display:flex;gap:8px;align-items:center;");
    for (const e of extra) row.appendChild(e);
    const dismiss = button("Dismiss", T.line, T.ink);
    dismiss.addEventListener("click", () => host.remove());
    row.appendChild(dismiss);
    return row;
  };

  // Show `text` in a copyable box inside the drawer, try the clipboard, offer download.
  async function presentCopyable(text: string, filename: string, kindLabel: string): Promise<void> {
    setDrawer(true);
    const ta = el(
      "textarea",
      `width:100%;height:110px;margin:6px 12px 10px;background:#0b1220;color:#cbd5e1;border:1px solid ${T.line};` +
        `border-radius:6px;font:11px/1.4 ui-monospace,Menlo,monospace;box-sizing:border-box;padding:6px;width:calc(100% - 24px);`,
    ) as HTMLTextAreaElement;
    ta.readOnly = true;
    ta.value = text;
    drawer.appendChild(ta);
    ta.focus();
    ta.select();
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      /* clipboard may be blocked; the textarea is selected as a fallback */
    }
    overlay.log(
      (copied ? `${kindLabel} copied to your clipboard.` : `${kindLabel} ready — copy it from the box above.`) +
        " Review it, then share it PRIVATELY with Josh (it may include identifying details — please don't post it publicly).",
    );
    const dl = button(`Download ${filename}`, T.accent);
    dl.style.margin = "0 12px 10px";
    dl.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    drawer.appendChild(dl);
  }

  let debugFn: (() => Promise<string>) | null = null;
  debugBtn.addEventListener("click", async () => {
    if (!debugFn || debugBtn.disabled) return;
    debugBtn.disabled = true;
    debugBtn.textContent = "Collecting…";
    let text: string;
    try {
      text = await debugFn();
    } catch (e) {
      text = `debug report failed: ${e}`;
    }
    await presentCopyable(text, "mychart-takeout-debug.txt", "Debug report");
    debugBtn.textContent = "Debug";
    debugBtn.disabled = false;
  });

  const overlay: Overlay = {
    root,
    log(line: string) {
      const div = document.createElement("div");
      div.textContent = line;
      logBox.appendChild(div);
      logBox.scrollTop = logBox.scrollHeight;
    },
    onDebug(fn: () => Promise<string>) {
      debugFn = fn;
    },

    setChecking(msg: string) {
      render("checking", statusLine(msg));
    },

    setReady(actions: ReadyActions) {
      const all = button("Export everything", T.accent);
      all.addEventListener("click", actions.onExportAll);
      const scan = linkButton("scan first & choose what to include…");
      scan.addEventListener("click", actions.onScanFirst);
      render(
        "ready",
        statusLine("Ready — signed-in MyChart detected. Keep this tab open."),
        all,
        scan,
      );
    },

    setBusy(status: string) {
      if (state === "busy" && busyLine) {
        busyLine.textContent = status;
        return;
      }
      const line = statusLine(status, T.ink);
      render("busy", line);
      busyLine = line;
    },

    setSelect(census: Census, onExport: (sel: Selection) => void) {
      const boxes: { key: keyof Omit<Selection, "excludeDocIds">; el: HTMLInputElement }[] = [];
      const docChecks: { dcsId: string; el: HTMLInputElement }[] = [];
      const rowCss = "display:flex;align-items:flex-start;gap:8px;";
      const row = (label: string, sub = "", indent = false): HTMLInputElement => {
        const wrap = el("label", rowCss + (indent ? "margin-left:22px;" : "") + "cursor:pointer;");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.style.cssText = "margin-top:2px;accent-color:#2563eb;";
        wrap.appendChild(cb);
        const text = el("span", "");
        text.appendChild(el("span", "", label));
        if (sub) text.appendChild(el("span", `display:block;color:${T.dim};font-size:11px;`, sub));
        wrap.appendChild(text);
        list.appendChild(wrap);
        return cb;
      };
      const list = el("div", "display:flex;flex-direction:column;gap:6px;");
      const docTotal =
        census.knownBytes > 0
          ? ` · ${fmtBytes(census.knownBytes)}${census.unknownCount ? "+" : ""}`
          : "";
      boxes.push({ key: "clinical", el: row("Clinical data", "results, visits, meds, notes, history…") });
      boxes.push({ key: "messages", el: row("Messages", "every conversation thread") });
      const docsCb = row("Documents", `${census.docs.length} files${docTotal}`);
      boxes.push({ key: "documents", el: docsCb });
      for (const d of census.docs.filter((x) => x.outlier)) {
        const cb = row(
          `include “${d.name}”`,
          `${d.ext.toUpperCase()} · ${d.bytes !== null ? fmtBytes(d.bytes) : "size unknown"} — unusually large`,
          true,
        );
        docChecks.push({ dcsId: d.dcsId, el: cb });
      }
      boxes.push({ key: "dom", el: row("Page snapshots", "rendered section pages (HTML)") });
      docsCb.addEventListener("change", () => {
        for (const c of docChecks) c.el.disabled = !docsCb.checked;
      });

      const go = button("Export selected", T.accent);
      go.addEventListener("click", () => {
        const sel: Selection = {
          clinical: true,
          messages: true,
          documents: true,
          dom: true,
          excludeDocIds: [],
        };
        for (const b of boxes) sel[b.key] = b.el.checked;
        if (sel.documents) {
          sel.excludeDocIds = docChecks.filter((c) => !c.el.checked).map((c) => c.dcsId);
        }
        onExport(sel);
      });
      render("select", statusLine("Your record contains:"), list, go);
    },

    setDone(zip: Uint8Array, filename = "mychart-export.zip") {
      const dl = button(`Download ${filename} (${fmtBytes(zip.length)})`, T.good);
      dl.addEventListener("click", () => {
        const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
      render("done", statusLine("Done — safe to close."), dl, dismissRow());
    },

    setFailed(message: string) {
      root.style.borderColor = T.badLine;
      title.style.background = T.bad;
      const banner = el(
        "div",
        `background:${T.bad};color:#fff;font-weight:600;white-space:pre-wrap;padding:8px 10px;border-radius:6px;`,
        message,
      );
      // Debug is promoted here — it's the one useful next step on failure.
      const dbg = button("Debug", T.line, T.ink);
      dbg.addEventListener("click", () => debugBtn.click());
      render("failed", banner, dismissRow(dbg));
    },
  };
  overlay.setChecking("Checking this is a MyChart page…");
  (host as HTMLElement & { __overlay?: Overlay }).__overlay = overlay;
  return overlay;
}
