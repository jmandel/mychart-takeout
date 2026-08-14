/** MANIFEST.json renderer (_write_manifest in the Python). */
import type { Summary } from "./summary";

/**
 * The Python version os.walks the output directory; here we count the files
 * saved through the store this run (same set during a real export — files
 * merely primed into memory for a report-only rebuild are not counted).
 * Top-level files count under their own name, exactly like the Python walk.
 */
export function renderManifest(
  S: Summary,
  savedFiles: string[],
  sizes?: Map<string, number>,
): string {
  const counts: Record<string, number> = {};
  for (const rel of savedFiles) {
    const top = rel.split("/")[0] ?? rel;
    counts[top] = (counts[top] ?? 0) + 1;
  }
  // Size accounting, so a huge export explains itself: which top dirs hold
  // the bytes, and which individual files dominate (a single uncompressed
  // document scan can be 10x everything else combined).
  const bytesByTop: Record<string, number> = {};
  let totalBytes = 0;
  for (const [rel, n] of sizes ?? []) {
    const top = rel.split("/")[0] ?? rel;
    bytesByTop[top] = (bytesByTop[top] ?? 0) + n;
    totalBytes += n;
  }
  const largest = [...(sizes ?? [])]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, bytes]) => ({ file, bytes }));
  return JSON.stringify(
    {
      generated: S.generated,
      source: S.source,
      file_counts_by_top_dir: counts,
      total_files: savedFiles.length,
      ...(sizes && sizes.size > 0
        ? { total_bytes: totalBytes, bytes_by_top_dir: bytesByTop, largest_files: largest }
        : {}),
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
