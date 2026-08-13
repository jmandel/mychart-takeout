/**
 * Re-export of the zip primitives for consumers outside this package's
 * dependency graph (tools/mock-mychart imports these relatively — fflate is
 * installed under packages/*, not hoisted to the workspace root).
 */
export { unzipSync, zipSync } from "fflate";
