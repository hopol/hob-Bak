// 每一段取绝对峰值，避免短促的声音被平均掉。
export function samplePeaks(samples: Float32Array, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor(i * samples.length / count);
    const end = Math.floor((i + 1) * samples.length / count);
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(samples[j]));
    return peak;
  });
}
