import { describe, expect, test } from "bun:test";
import { exportFilename } from "../src/filename";

describe("exportFilename", () => {
  test("incorporates host, strips www, sanitizes", () => {
    expect(exportFilename("mychart.example.org")).toBe("mychart-export-mychart.example.org.zip");
    expect(exportFilename("www.chart.example.org")).toBe("mychart-export-chart.example.org.zip");
    expect(exportFilename("patientgateway.example.org")).toBe(
      "mychart-export-patientgateway.example.org.zip",
    );
  });
  test("falls back to generic when host empty", () => {
    expect(exportFilename("")).toBe("mychart-export.zip");
  });
  test("incorporates active patient (proxy exports don't collide)", () => {
    expect(exportFilename("www.chart.example.org", "Robin")).toBe(
      "mychart-export-chart.example.org-Robin.zip",
    );
    expect(exportFilename("", "Robin")).toBe("mychart-export-Robin.zip");
  });
});
