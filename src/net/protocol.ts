import type { GameEvent } from '../core/types';
import type { View } from '../core/view';

export interface LobbyPlayer {
  slot: number;
  name: string;
}

// 信頼性あり（順序保証）チャネルで送るメッセージ
export type ReliableMsg =
  | { t: 'ping' }
  | { t: 'hello'; name: string } // ゲスト→ホスト
  | { t: 'welcome'; slot: number } // ホスト→ゲスト
  | { t: 'lobby'; players: LobbyPlayer[]; durationSec: number } // ホスト→ゲスト
  | { t: 'start'; players: LobbyPlayer[]; durationSec: number } // ホスト→ゲスト
  | { t: 'end'; scores: { slot: number; score: number }[] }; // ホスト→ゲスト

// 信頼性なし（最新のみ有効）チャネルで送るメッセージ
export type UnreliableMsg =
  | { t: 'in'; b: number } // ゲスト→ホスト：入力ビット
  | { t: 's'; d: EncodedView }; // ホスト→ゲスト：スナップショット

type Num = number;
export interface EncodedView {
  m: 0 | 1; // 0=solo 1=versus
  k: Num; // tick
  tl: Num; // 残り時間 (0.1秒単位)
  w: Num;
  o: 0 | 1;
  sh: [Num, Num, Num, Num, Num, Num, Num][]; // id,x,y,angle*1000,flags,score,lives
  b: [Num, Num, Num, Num][]; // id,x,y,owner
  r: [Num, Num, Num, Num, Num][]; // id,size,x,y,angle*100
  u: [Num, Num, Num, 0 | 1] | 0; // id,x,y,small
  e: GameEvent[];
}

const round = Math.round;
const F_ALIVE = 1;
const F_INV = 2;
const F_THR = 4;

export function encodeView(v: View): EncodedView {
  return {
    m: v.mode === 'versus' ? 1 : 0,
    k: v.tick,
    tl: round(v.timeLeft * 10),
    w: v.wave,
    o: v.over ? 1 : 0,
    sh: v.ships.map((s) => [
      s.id,
      round(s.x),
      round(s.y),
      round(s.a * 1000),
      (s.alive ? F_ALIVE : 0) | (s.inv ? F_INV : 0) | (s.thr ? F_THR : 0),
      s.score,
      s.lives,
    ]),
    b: v.bullets.map((b) => [b.id, round(b.x), round(b.y), b.o]),
    r: v.rocks.map((r) => [r.id, r.s, round(r.x), round(r.y), round(r.a * 100)]),
    u: v.ufo ? [v.ufo.id, round(v.ufo.x), round(v.ufo.y), v.ufo.small ? 1 : 0] : 0,
    e: v.events.map((e) => ('x' in e ? { ...e, x: round(e.x), y: round(e.y) } : e)),
  };
}

export function decodeView(d: EncodedView): View {
  return {
    mode: d.m === 1 ? 'versus' : 'solo',
    tick: d.k,
    timeLeft: d.tl / 10,
    wave: d.w,
    over: d.o === 1,
    ships: d.sh.map(([id, x, y, a, f, score, lives]) => ({
      id,
      x,
      y,
      a: a / 1000,
      alive: (f & F_ALIVE) !== 0,
      inv: (f & F_INV) !== 0,
      thr: (f & F_THR) !== 0,
      score,
      lives,
    })),
    bullets: d.b.map(([id, x, y, o]) => ({ id, x, y, o })),
    rocks: d.r.map(([id, s, x, y, a]) => ({ id, s, x, y, a: a / 100 })),
    ufo: d.u ? { id: d.u[0], x: d.u[1], y: d.u[2], small: d.u[3] === 1 } : null,
    events: d.e,
  };
}
