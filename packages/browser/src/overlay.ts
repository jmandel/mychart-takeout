/** Minimal dependency-free progress overlay for the in-page exporter. */

const OVERLAY_ID = "__mychart_export_overlay";

export interface Overlay {
  log(line: string): void;
  /** Swap the Start button for a Download button holding the finished zip. */
  setDone(zip: Uint8Array, filename?: string): void;
  setRunning(): void;
  /** Reveal the Start button once we've confirmed a signed-in MyChart page. */
  setReady(): void;
  /** Failure state: no download, red banner, clear message + Dismiss. */
  setError(message: string): void;
  onStart(fn: () => void): void;
  /** Wire the "Debug" button: fn returns the report text to copy/download. */
  onDebug(fn: () => Promise<string>): void;
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
  // Hidden until setReady() confirms this is a signed-in MyChart page.
  startBtn.style.cssText =
    "background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;display:none;";
  bar.appendChild(startBtn);

  const note = document.createElement("span");
  note.textContent = "Checking this is a MyChart page…";
  note.style.cssText = "opacity:.7;align-self:center;";
  bar.appendChild(note);

  // Always-present Debug button — useful precisely when detection fails.
  const debugBtn = document.createElement("button");
  debugBtn.textContent = "Debug";
  debugBtn.title = "Collect a shareable, PHI-free debug report";
  debugBtn.style.cssText =
    "background:#374151;color:#e5e7eb;border:0;border-radius:6px;padding:6px 12px;" +
    "cursor:pointer;font:inherit;margin-left:auto;";
  bar.appendChild(debugBtn);

  document.body.appendChild(root);

  let startFn: (() => void) | null = null;
  let debugFn: (() => Promise<string>) | null = null;
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
    onDebug(fn: () => Promise<string>) {
      debugFn = fn;
    },
    setReady() {
      startBtn.style.display = "";
      note.textContent = "Ready — click Start export. Keep this tab open.";
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
    setError(message: string) {
      // No download — make failure unmistakable (red), not a fake "Done".
      startBtn.remove();
      root.style.borderColor = "#b91c1c";
      title.style.background = "#7f1d1d";
      const banner = document.createElement("div");
      banner.textContent = message;
      banner.style.cssText =
        "padding:8px 12px;background:#7f1d1d;color:#fff;font-weight:600;white-space:pre-wrap;";
      root.insertBefore(banner, bar);
      note.textContent = "";
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
  debugBtn.addEventListener("click", async () => {
    if (!debugFn || debugBtn.disabled) return;
    debugBtn.disabled = true;
    const label = debugBtn.textContent;
    debugBtn.textContent = "Collecting…";
    let text: string;
    try {
      text = await debugFn();
    } catch (e) {
      text = `debug report failed: ${e}`;
    }
    // Show the report in a copyable box + Copy/Download; try clipboard too.
    const ta = document.createElement("textarea");
    ta.readOnly = true;
    ta.value = text;
    ta.style.cssText =
      "width:100%;height:120px;margin-top:6px;background:#0b1220;color:#cbd5e1;border:1px solid #374151;" +
      "border-radius:6px;font:11px/1.4 ui-monospace,Menlo,monospace;box-sizing:border-box;padding:6px;";
    logBox.appendChild(ta);
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
      copied
        ? "Debug report copied to your clipboard — paste it back to us."
        : "Debug report ready — select the box above, copy it, and paste it back to us.",
    );
    const dl = document.createElement("button");
    dl.textContent = "Download debug report";
    dl.style.cssText =
      "background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;";
    dl.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "mychart-takeout-debug.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    bar.insertBefore(dl, debugBtn);
    debugBtn.textContent = label;
    debugBtn.disabled = false;
  });
  (root as HTMLElement & { __overlay?: Overlay }).__overlay = overlay;
  return overlay;
}
