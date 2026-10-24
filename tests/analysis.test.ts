import { describe, expect, it } from "vitest";
import { csvCell, summarizeSamples } from "../src/analysis";

describe("replicate statistics and interoperable exports", () => {
  it("does not invent uncertainty from a single run", () => {
    expect(summarizeSamples([12])).toMatchObject({
      n: 1,
      mean: 12,
      standardDeviation: null,
      confidence95: null,
    });
  });
  it("uses sample variance and t uncertainty for independent runs", () => {
    const result = summarizeSamples([1, 2, 3]);
    expect(result.mean).toBe(2);
    expect(result.standardDeviation).toBe(1);
    expect(result.confidence95![0]).toBeCloseTo(2 - 4.303 / Math.sqrt(3));
    expect(result.confidence95![1]).toBeCloseTo(2 + 4.303 / Math.sqrt(3));
  });
  it("quotes CSV fields and prevents formula evaluation on import", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });
});
