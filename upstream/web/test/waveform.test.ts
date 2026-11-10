import { describe, expect, it } from "vitest";
import { samplePeaks } from "../src/waveform.ts";

describe("samplePeaks", () => {
  it("取每段的绝对峰值，不编造波形", () => {
    expect(samplePeaks(new Float32Array([0, -0.5, 0.25, 1, -0.75, 0]), 3)).toEqual([0.5, 1, 0.75]);
    expect(samplePeaks(new Float32Array(4), 2)).toEqual([0, 0]);
  });
});
