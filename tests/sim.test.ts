import { describe, expect, it } from 'vitest';
import * as C from '../src/core/constants';
import { createGame, removeShip, step, wrappedDist2 } from '../src/core/sim';
import type { GameState } from '../src/core/types';

function clearField(state: GameState): void {
  state.rocks = [];
  state.bullets = [];
  state.ufo = null;
  state.ufoTimer = 1e9;
  state.waveTimer = 1e9; // ウェーブ補充を止める
  for (const s of state.ships) s.invulnTimer = 0;
}

describe('wrappedDist2', () => {
  it('画面端をまたいだ距離を最短で測る', () => {
    expect(wrappedDist2(5, 100, C.WORLD_W - 5, 100)).toBe(100);
    expect(wrappedDist2(100, 3, 100, C.WORLD_H - 3)).toBe(36);
  });
});

describe('createGame', () => {
  it('ソロは残機3・第1ウェーブは大小惑星4個', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 1 });
    expect(s.ships).toHaveLength(1);
    expect(s.ships[0].lives).toBe(3);
    expect(s.rocks).toHaveLength(4);
    expect(s.rocks.every((r) => r.size === 3)).toBe(true);
  });

  it('同じシードなら同じ結果になる', () => {
    const a = createGame({ mode: 'versus', players: [0, 1], seed: 42 });
    const b = createGame({ mode: 'versus', players: [0, 1], seed: 42 });
    for (let i = 0; i < 300; i++) {
      step(a, [C.IN_FIRE | C.IN_LEFT, C.IN_THRUST]);
      step(b, [C.IN_FIRE | C.IN_LEFT, C.IN_THRUST]);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('小惑星', () => {
  it('弾が当たると分裂し得点が入る（大→中2、中→小2、小→消滅）', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 3 });
    clearField(s);
    const ship = s.ships[0];
    const hit = (size: number) => {
      s.rocks = [{ id: 999, size, x: 600, y: 100, vx: 0, vy: 0, angle: 0, spin: 0 }];
      s.bullets = [{ id: 1000, owner: 0, x: 600, y: 100, vx: 0, vy: 0, life: 1 }];
      const before = ship.score;
      step(s, [0]);
      return { gained: ship.score - before, children: s.rocks.map((r) => r.size) };
    };
    expect(hit(3)).toEqual({ gained: 20, children: [2, 2] });
    expect(hit(2)).toEqual({ gained: 50, children: [1, 1] });
    expect(hit(1)).toEqual({ gained: 100, children: [] });
  });

  it('全滅すると次のウェーブが始まる', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 5 });
    s.rocks = [];
    s.ufoTimer = 1e9;
    for (let i = 0; i < C.TICK_RATE * (C.WAVE_DELAY + 0.5); i++) step(s, [0]);
    expect(s.wave).toBe(2);
    expect(s.rocks).toHaveLength(6);
  });
});

describe('対戦', () => {
  it('他プレイヤーを撃つと撃破され、撃った側に200点', () => {
    const s = createGame({ mode: 'versus', players: [0, 1], seed: 7 });
    clearField(s);
    const [a, b] = s.ships;
    s.bullets = [{ id: 1000, owner: 0, x: b.x, y: b.y, vx: 0, vy: 0, life: 1 }];
    step(s, [0, 0]);
    expect(b.alive).toBe(false);
    expect(a.score).toBe(C.PLAYER_KILL_POINTS);
    expect(s.events).toContainEqual({ k: 'kill', killer: 0, victim: 1 });
  });

  it('自分の弾は自分に当たらない', () => {
    const s = createGame({ mode: 'versus', players: [0, 1], seed: 7 });
    clearField(s);
    const a = s.ships[0];
    s.bullets = [{ id: 1000, owner: 0, x: a.x, y: a.y, vx: 0, vy: 0, life: 1 }];
    step(s, [0, 0]);
    expect(a.alive).toBe(true);
  });

  it('無敵中は撃破されない', () => {
    const s = createGame({ mode: 'versus', players: [0, 1], seed: 7 });
    clearField(s);
    const b = s.ships[1];
    b.invulnTimer = 1;
    s.bullets = [{ id: 1000, owner: 0, x: b.x, y: b.y, vx: 0, vy: 0, life: 1 }];
    step(s, [0, 0]);
    expect(b.alive).toBe(true);
  });

  it('撃破後は一定時間で無敵状態でリスポーンする（対戦は残機なし）', () => {
    const s = createGame({ mode: 'versus', players: [0, 1], seed: 7 });
    clearField(s);
    const b = s.ships[1];
    s.bullets = [{ id: 1000, owner: 0, x: b.x, y: b.y, vx: 0, vy: 0, life: 1 }];
    step(s, [0, 0]);
    for (let i = 0; i < C.TICK_RATE * C.SHIP_RESPAWN_TIME + 1; i++) step(s, [0, 0]);
    expect(b.alive).toBe(true);
    expect(b.invulnTimer).toBeGreaterThan(0);
    expect(s.over).toBe(false);
  });

  it('制限時間で終了する', () => {
    const s = createGame({ mode: 'versus', players: [0, 1], seed: 9, durationSec: 2 });
    for (let i = 0; i < C.TICK_RATE * 2 - 1; i++) step(s, [0, 0]);
    expect(s.over).toBe(false);
    step(s, [0, 0]);
    expect(s.over).toBe(true);
  });

  it('切断したプレイヤーの船と弾を取り除ける', () => {
    const s = createGame({ mode: 'versus', players: [0, 1, 2], seed: 9 });
    s.bullets = [{ id: 1000, owner: 2, x: 0, y: 0, vx: 0, vy: 0, life: 1 }];
    removeShip(s, 2);
    expect(s.ships.map((x) => x.id)).toEqual([0, 1]);
    expect(s.bullets).toHaveLength(0);
  });
});

describe('ソロ', () => {
  it('残機が尽きるとゲームオーバー', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 11 });
    const ship = s.ships[0];
    for (let life = 0; life < C.SOLO_LIVES; life++) {
      clearField(s);
      s.bullets = [{ id: 2000 + life, owner: -1, x: ship.x, y: ship.y, vx: 0, vy: 0, life: 1 }];
      step(s, [0]);
      expect(ship.alive).toBe(false);
      for (let i = 0; i < C.TICK_RATE * C.SHIP_RESPAWN_TIME + 1 && !s.over; i++) step(s, [0]);
    }
    expect(s.over).toBe(true);
  });

  it('10000点ごとに残機が増える', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 12 });
    clearField(s);
    const ship = s.ships[0];
    ship.score = C.EXTRA_LIFE_EVERY - 50;
    s.rocks = [{ id: 999, size: 2, x: 600, y: 100, vx: 0, vy: 0, angle: 0, spin: 0 }];
    s.bullets = [{ id: 1000, owner: 0, x: 600, y: 100, vx: 0, vy: 0, life: 1 }];
    step(s, [0]);
    expect(ship.lives).toBe(C.SOLO_LIVES + 1);
  });
});

describe('船の操作', () => {
  it('発射は同時弾数の上限まで', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 13 });
    clearField(s);
    for (let i = 0; i < 60; i++) step(s, [C.IN_FIRE]);
    expect(s.bullets.filter((b) => b.owner === 0).length).toBeLessThanOrEqual(C.SHIP_MAX_BULLETS);
    expect(s.bullets.length).toBeGreaterThan(0);
  });

  it('推進すると向きの方向へ加速し、最高速度を超えない', () => {
    const s = createGame({ mode: 'solo', players: [0], seed: 14 });
    clearField(s);
    const ship = s.ships[0];
    for (let i = 0; i < 600; i++) step(s, [C.IN_THRUST]);
    expect(ship.vy).toBeLessThan(0); // 上向き
    expect(Math.hypot(ship.vx, ship.vy)).toBeLessThanOrEqual(C.SHIP_MAX_SPEED + 1e-6);
  });
});

describe('UFO', () => {
  it('時間経過で出現し、撃つと得点', () => {
    const s = createGame({ mode: 'versus', players: [0, 1], seed: 15 });
    clearField(s);
    s.ufoTimer = 0;
    step(s, [0, 0]);
    expect(s.ufo).not.toBeNull();
    const ufo = s.ufo!;
    ufo.x = 640;
    ufo.y = 360;
    s.bullets = [{ id: 1000, owner: 1, x: 640, y: 360, vx: 0, vy: 0, life: 1 }];
    step(s, [0, 0]);
    expect(s.ufo).toBeNull();
    expect(s.ships[1].score).toBe(ufo.small ? C.UFO_POINTS.small : C.UFO_POINTS.large);
  });
});
