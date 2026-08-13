import type { PhaseCtx } from "../ctx";
import { ccda } from "./ccda";
import { dom } from "./dom";
import { flowsheets } from "./flowsheets";
import { messages } from "./messages";
import { structured } from "./structured";
import { testResults } from "./testResults";
import { visits } from "./visits";

export type Phase = (ctx: PhaseCtx) => Promise<void>;

/**
 * Phase registry — 1:1 ports of export.py's phase_* functions.
 * (The salvage phase is CDP-only and lives in packages/cdp because it reads
 * the driver's network log.)
 */
export const phases: Record<
  "structured" | "testResults" | "visits" | "messages" | "flowsheets" | "ccda" | "dom",
  Phase
> = {
  structured,
  testResults,
  visits,
  messages,
  flowsheets,
  ccda,
  dom,
};
