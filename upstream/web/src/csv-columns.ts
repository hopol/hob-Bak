/** 只有每一行都有有效数字的列才按数字对齐；首行是表头。 */
export function numericColumns(rows: string[][]): boolean[] {
  const [header, ...body] = rows;
  if (!header) return [];
  return header.map((_, index) => body.length > 0 && body.every((row) => {
    const value = row[index]?.trim();
    return !!value && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
  }));
}
