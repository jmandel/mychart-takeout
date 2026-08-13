/** Minimal dependency-free progress overlay for the in-page exporter. */

const OVERLAY_ID = "__mychart_export_overlay";

export interface Overlay {
  log(line: string): void;
  /** Swap the Start button for a Download button holding the finished zip. */
  setDone(zip: Uint8Array, filename?: string): void;
  setRunning(): void;
  onStart(fn: () => void): void;
  root: HTMLElement;
}

/** Create (or return the existing) overlay panel. Idempotent across re-pastes. */
export function ensureOverlay(): Overlay {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing && (existing as HTMLElement & { __overlay?: Overlay }).__overlay) {
    return (existing as HTMLElement & { __overlay?: Overlay }).__overlay!;
  }
  existing?.remove();

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;max-height:60vh;" +
    "background:#111827;color:#e5e7eb;font:12px/1.5 ui-monospace,Menlo,monospace;" +
    "border:1px solid #374151;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5);" +
    "display:flex;flex-direction:column;overflow:hidden;";

  const title = document.createElement("div");
  title.style.cssText =
    "padding:8px 12px;font-weight:700;background:#1f2937;border-bottom:1px solid #374151;" +
    "display:flex;align-items:center;justify-content:space-between;";
  const titleText = document.createElement("span");
  titleText.textContent = "MyChart Export";
  title.appendChild(titleText);
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close (does not cancel a download already saved)";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.cssText =
    "background:transparent;color:#9ca3af;border:0;font:inherit;font-size:14px;line-height:1;" +
    "cursor:pointer;padding:0 4px;";
  closeBtn.addEventListener("click", () => root.remove());
  title.appendChild(closeBtn);
  root.appendChild(title);

  const logBox = document.createElement("div");
  logBox.style.cssText = "padding:8px 12px;overflow-y:auto;flex:1;white-space:pre-wrap;";
  root.appendChild(logBox);

  const bar = document.createElement("div");
  bar.style.cssText = "padding:8px 12px;border-top:1px solid #374151;display:flex;gap:8px;";
  root.appendChild(bar);

  const startBtn = document.createElement("button");
  startBtn.textContent = "Start export";
  startBtn.style.cssText =
    "background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;";
  bar.appendChild(startBtn);

  const note = document.createElement("span");
  note.textContent = "Keep this tab open; close the tab to cancel.";
  note.style.cssText = "opacity:.7;align-self:center;";
  bar.appendChild(note);

  document.body.appendChild(root);

  let startFn: (() => void) | null = null;
  const overlay: Overlay = {
    root,
    log(line: string) {
      const div = document.createElement("div");
      div.textContent = line;
      logBox.appendChild(div);
      logBox.scrollTop = logBox.scrollHeight;
    },
    onStart(fn: () => void) {
      startFn = fn;
    },
    setRunning() {
      startBtn.disabled = true;
      startBtn.textContent = "Running…";
      startBtn.style.background = "#374151";
    },
    setDone(zip: Uint8Array, filename = "mychart-export.zip") {
      startBtn.remove();
      const dl = document.createElement("button");
      dl.textContent = `Download ${filename} (${(zip.length / 1024 / 1024).toFixed(1)} MB)`;
      dl.style.cssText =
        "background:#059669;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;";
      dl.addEventListener("click", () => {
        const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
      bar.insertBefore(dl, note);
      // Export finished: the tab no longer needs to stay open. Offer an
      // explicit Dismiss in addition to the title-bar ✕.
      note.textContent = "Done — safe to close.";
      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      dismiss.style.cssText =
        "background:#374151;color:#e5e7eb;border:0;border-radius:6px;padding:6px 12px;" +
        "cursor:pointer;font:inherit;margin-left:auto;";
      dismiss.addEventListener("click", () => root.remove());
      bar.appendChild(dismiss);
    },
  };
  startBtn.addEventListener("click", () => {
    overlay.setRunning();
    startFn?.();
  });
  (root as HTMLElement & { __overlay?: Overlay }).__overlay = overlay;
  return overlay;
}
