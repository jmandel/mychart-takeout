import type { PhaseCtx } from "../ctx";
import { accessLog } from "./accessLog";
import { ccda } from "./ccda";
import { documents } from "./documents";
export { OTHER_DOCUMENTS_LIST_KEY } from "./documents";
import { flowsheets } from "./flowsheets";
import { messages } from "./messages";
import { structured } from "./structured";
import { testResults } from "./testResults";
import { visits } from "./visits";

export type Phase = (ctx: PhaseCtx) => Promise<void>;

/**
 * Phase registry. (The salvage phase is CDP-only and lives in packages/cdp
 * because it reads the driver's network log. There is deliberately no page-
 * snapshot phase: field data showed the snapshots were app-shell boilerplate
 * duplicating structured JSON. Billing is the one domain that is server-
 * rendered only — TODO: capture it explicitly once we've seen how its page
 * varies across instances.)
 */
export const phases: Record<
  | "structured" | "testResults" | "visits" | "messages" | "flowsheets"
  | "accessLog" | "documents" | "ccda",
  Phase
> = {
  structured,
  testResults,
  visits,
  messages,
  flowsheets,
  accessLog,
  documents,
  ccda,
};
