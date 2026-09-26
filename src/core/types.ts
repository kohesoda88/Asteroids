import type { RngState } from './rng';

export type GameMode = 'solo' | 'versus';

export interface Ship {
  id: number; // プレイヤースロット 0〜3
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  alive: boolean;
  respawnTimer: number;
  invulnTimer: number;
  fireCooldown: number;
  hyperCooldown: number;
  thrusting: boolean;
  score: number;
  lives: number; // ソロのみ使用
  nextExtraLife: number;
}

export interface Bullet {
  id: number;
  owner: number; // プレイヤースロット、UFO は -1
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export interface Rock {
  id: number;
  size: number; // 3=大, 2=中, 1=小
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
}

export interface Ufo {
  id: number;
  small: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fireTimer: number;
  turnTimer: number;
}

export type GameEvent =
  | { k: 'boom'; x: number; y: number; s: number; c: number } // s: 大きさ, c: 色（プレイヤー番号 / -1=小惑星 / -2=UFO）
  | { k: 'fire'; o: number }
  | { k: 'hyper'; o: number; x: number; y: number }
  | { k: 'kill'; killer: number; victim: number }
  | { k: 'life'; o: number };

export interface GameState {
  mode: GameMode;
  tick: number;
  durationTicks: number; // 対戦の制限時間（ソロは 0）
  wave: number;
  waveTimer: number;
  ships: Ship[];
  bullets: Bullet[];
  rocks: Rock[];
  ufo: Ufo | null;
  ufoTimer: number;
  nextId: number;
  rng: RngState;
  over: boolean;
  events: GameEvent[]; // 直近の step で発生したイベント
}
