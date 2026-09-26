// mulberry32: シード付き疑似乱数。状態を GameState に保持して再現性を確保する
export interface RngState {
  seed: number;
}

export function nextRandom(s: RngState): number {
  s.seed = (s.seed + 0x6d2b79f5) | 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randRange(s: RngState, min: number, max: number): number {
  return min + nextRandom(s) * (max - min);
}

// 整数から決定的な疑似乱数列を作る（小惑星の形状生成など描画用）
export function hashRandom(n: number): () => number {
  const s: RngState = { seed: n * 2654435761 };
  return () => nextRandom(s);
}
