import { describe, expect, test } from "bun:test";
import { flagOutliers, type CensusDoc } from "../src/census";

const doc = (dcsId: string, bytes: number | null): CensusDoc => ({
  dcsId,
  name: dcsId,
  ext: "pdf",
  bytes,
  outlier: false,
});

describe("flagOutliers", () => {
  test("flags a file >10× the median and >1MB (the field case)", () => {
    const flagged = flagOutliers([doc("a", 2_000), doc("b", 40_000), doc("c", 63_000_000)]);
    expect(flagged.map((d) => d.outlier)).toEqual([false, false, true]);
  });

  test("small exports never flag: 10× median under the 1MB floor", () => {
    const flagged = flagOutliers([doc("a", 2_000), doc("b", 30_000), doc("c", 50_000)]);
    expect(flagged.every((d) => !d.outlier)).toBe(true);
  });

  test("unknown sizes are never outliers and don't skew the median", () => {
    const flagged = flagOutliers([doc("a", null), doc("b", 1_000), doc("c", 20_000_000)]);
    expect(flagged.map((d) => d.outlier)).toEqual([false, false, true]);
  });

  test("all-unknown → nothing flagged", () => {
    expect(flagOutliers([doc("a", null)]).map((d) => d.outlier)).toEqual([false]);
  });
});
