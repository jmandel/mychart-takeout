export * from "./filename";
export * from "./detect";
export * from "./debug";
/**
 * Public surface for tests/tooling. NOTE: main.ts (the bundle entry) is
 * deliberately NOT re-exported — importing it has side effects (creates the
 * overlay and registers the global API).
 */
export * from "./client";
export * from "./zipSink";
export * from "./fetchDom";
export * from "./overlay";
