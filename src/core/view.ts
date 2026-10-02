import { WORLD_H, WORLD_W } from './constants';
import { timeLeftSec, wrappedDist2 } from './sim';
import type { GameEvent, GameMode, GameState } from './types';

// 描画に必要な最小限の状態。ソロではローカルの GameState から、
// オンラインのゲストではホストから届くスナップショットから作られる。
export interface ViewShip {
  id: number;
  x: number;
  y: number;
  a: number;
  alive: boolean;
  inv: boolean;
  thr: boolean;
  score: number;
  lives: number;
}

export interface ViewBullet {
  id: number;
  x: number;
  y: number;
  o: number;
}

export interface ViewRock {
  id: number;
  s: number;
  x: number;
  y: number;
  a: number;
}

export interface ViewUfo {
  id: number;
  x: number;
  y: number;
  small: boolean;
}

export interface View {
  mode: GameMode;
  tick: number;
  timeLeft: number;
  wave: number;
  over: boolean;
  ships: ViewShip[];
  bullets: ViewBullet[];
  rocks: ViewRock[];
  ufo: ViewUfo | null;
  events: GameEvent[];
}

export function toView(state: GameState, events: GameEvent[] = state.events): View {
  return {
    mode: state.mode,
    tick: state.tick,
    timeLeft: timeLeftSec(state),
    wave: state.wave,
    over: state.over,
    ships: state.ships.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      a: s.angle,
      alive: s.alive,
      inv: s.invulnTimer > 0,
      thr: s.thrusting,
      score: s.score,
      lives: s.lives,
    })),
    bullets: state.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y, o: b.owner })),
    rocks: state.rocks.map((r) => ({ id: r.id, s: r.size, x: r.x, y: r.y, a: r.angle })),
    ufo: state.ufo ? { id: state.ufo.id, x: state.ufo.x, y: state.ufo.y, small: state.ufo.small } : null,
    events,
  };
}

// ---- 補間（ゲスト側） ----

function lerpWrapped(a: number, b: number, t: number, max: number): number {
  let d = b - a;
  if (d > max / 2) d -= max;
  else if (d < -max / 2) d += max;
  const v = a + d * t;
  return ((v % max) + max) % max;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function lerpList<T extends { id: number; x: number; y: number }>(
  from: T[],
  to: T[],
  t: number,
  extra?: (p: T, n: T, out: T) => void,
): T[] {
  const prev = new Map(from.map((e) => [e.id, e]));
  return to.map((n) => {
    const p = prev.get(n.id);
    if (!p) return n;
    const out = { ...n, x: lerpWrapped(p.x, n.x, t, WORLD_W), y: lerpWrapped(p.y, n.y, t, WORLD_H) };
    extra?.(p, n, out);
    return out;
  });
}

/** 2つのスナップショット a→b の間を t(0..1) で補間する。存在・フラグ類は b に従う */
export function interpolateView(a: View, b: View, t: number): View {
  return {
    ...b,
    ships: lerpList(a.ships, b.ships, t, (p, n, o) => {
      o.a = lerpAngle(p.a, n.a, t);
      // 復活などの瞬間移動は補間しない
      if ((!p.alive && n.alive) || wrappedDist2(p.x, p.y, n.x, n.y) > 80 * 80) {
        o.x = n.x;
        o.y = n.y;
      }
    }),
    bullets: lerpList(a.bullets, b.bullets, t),
    rocks: lerpList(a.rocks, b.rocks, t, (p, n, o) => {
      o.a = lerpAngle(p.a, n.a, t);
    }),
    ufo:
      a.ufo && b.ufo && a.ufo.id === b.ufo.id
        ? { ...b.ufo, x: a.ufo.x + (b.ufo.x - a.ufo.x) * t, y: lerpWrapped(a.ufo.y, b.ufo.y, t, WORLD_H) }
        : b.ufo,
    events: [],
  };
}
