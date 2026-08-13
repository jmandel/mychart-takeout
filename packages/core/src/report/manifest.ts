/** MANIFEST.json renderer (_write_manifest in the Python). */
import type { Summary } from "./summary";

/**
 * The Python version os.walks the output directory; here we count the files
 * saved through the store this run (same set during a real export — files
 * merely primed into memory for a report-only rebuild are not counted).
 * Top-level files count under their own name, exactly like the Python walk.
 */
export function renderManifest(S: Summary, savedFiles: string[]): string {
  const counts: Record<string, number> = {};
  for (const rel of savedFiles) {
    const top = rel.split("/")[0] ?? rel;
    counts[top] = (counts[top] ?? 0) + 1;
  }
  return JSON.stringify(
    {
      generated: S.generated,
      source: S.source,
      file_counts_by_top_dir: counts,
      total_files: savedFiles.length,
      record_counts: {
        problems: S.problems.length,
        allergies: S.allergies.length,
        immunizations: S.immunizations.length,
        medications: S.medications.length,
        test_result_orders: S.test_results.length,
        encounters: S.encounters.length,
        message_threads: S.messages.threads,
        messages: S.messages.total_messages,
      },
    },
    null,
    2,
  );
}
