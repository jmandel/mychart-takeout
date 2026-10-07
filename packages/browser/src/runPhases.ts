import { phases, type PhaseCtx } from "@mychart/core";

export interface ExportSelection {
  ccda?: boolean;
  /** accessLog is opt-in: the audit trail can run to thousands of pages
   *  (10k third-party entries on one record) and isn't part of the record. */
  categories?: { clinical?: boolean; messages?: boolean; documents?: boolean; accessLog?: boolean };
}

/**
 * 0 = no time limit, which is the default for both. An export that is still
 * making progress is never cut off by the clock: lists end on the portal's own
 * end signal or a no-progress backstop (paging.ts), failures trip the circuit
 * breaker / request timeouts / sign-out detection, and the user can press
 * Stop & download at any time. (A 15-minute cap here once cut a slow but
 * healthy export off mid-messages.) Tests pass explicit budgets.
 */
export const BROWSER_BUDGETS = { recordsMs: 0, accessLogMs: 0 };

export interface PhaseTiming {
  phase: keyof typeof phases;
  ms: number;
  abortedDuring: boolean;
}

/** Records first; the opt-in access log last, so a long audit history can't
 * hold up record downloads. Optional budgets (0 = none). Never clear an abort
 * or reset the shared circuit-breaker state. */
export async function runBrowserPhases(
  ctx: PhaseCtx,
  selection: ExportSelection,
  onStart: (phase: keyof typeof phases, index: number, total: number) => void,
  budgets = BROWSER_BUDGETS,
): Promise<PhaseTiming[]> {
  const cat = { clinical: true, messages: true, documents: true, accessLog: false, ...selection.categories };
  const order: (keyof typeof phases)[] = [
    ...(cat.clinical ? (["structured", "testResults", "visits", "flowsheets"] as const) : []),
    ...(cat.messages ? (["messages"] as const) : []),
    ...(cat.documents ? (["documents"] as const) : []),
    ...(selection.ccda ? (["ccda"] as const) : []),
    ...(cat.accessLog ? (["accessLog"] as const) : []),
  ];
  const timings: PhaseTiming[] = [];
  if (!ctx.signal.aborted) ctx.health.deadlineAt = budgets.recordsMs > 0 ? Date.now() + budgets.recordsMs : 0;
  for (let i = 0; i < order.length; i++) {
    const name = order[i]!;
    if (ctx.signal.aborted) {
      // Whole phases used to vanish from the gaps report when the driver
      // broke out of the loop. Record selected work that was never attempted.
      for (const skipped of order.slice(i)) {
        ctx.rec("phase", skipped, null, `not attempted: ${ctx.signal.reason}`, { outcome: "skipped" });
      }
      break;
    }
    if (name === "accessLog") ctx.health.deadlineAt = budgets.accessLogMs > 0 ? Date.now() + budgets.accessLogMs : 0;
    onStart(name, i + 1, order.length);
    const t0 = Date.now();
    try {
      await phases[name](ctx);
    } catch (e) {
      // One failed phase should not discard other downloadable data.
      ctx.log(`!! phase ${name} failed: ${e}`);
      ctx.rec("phase-error", name, null, `phase did not finish: ${e}`, { outcome: "incomplete" });
    } finally {
      timings.push({ phase: name, ms: Date.now() - t0, abortedDuring: ctx.signal.aborted });
    }
  }
  return timings;
}
