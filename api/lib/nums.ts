export function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return NaN;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

