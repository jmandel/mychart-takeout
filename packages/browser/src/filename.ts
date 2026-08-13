/** Download filename incorporating the instance host and (when known) the
 *  active patient, e.g. mychart-export-example.org-Robin.zip — so exporting a
 *  proxied record (navigate to it in the UI, then run) doesn't collide with
 *  your own. Generic fallback when host is unknown. */
export function exportFilename(host: string, patient?: string): string {
  const clean = (s: string) => (s || "").replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "");
  const h = clean((host || "").replace(/^www\./, ""));
  const p = clean(patient || "");
  const parts = ["mychart-export", h, p].filter(Boolean);
  return parts.length > 1 ? parts.join("-") + ".zip" : "mychart-export.zip";
}
