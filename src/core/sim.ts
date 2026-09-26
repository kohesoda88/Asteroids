import * as C from './constants';
import { nextRandom, randRange } from './rng';
import type { Bullet, GameMode, GameState, Rock, Ship, Ufo } from './types';

export interface GameOptions {
  mode: GameMode;
  players: number[]; // 参加するプレイヤースロット
  seed?: number;
  durationSec?: number;
}

// 対戦時の出現位置（ワールドに対する割合）
const SPAWN_POINTS: [number, number][] = [
  [0.25, 0.3],
  [0.75, 0.7],
  [0.75, 0.3],
  [0.25, 0.7],
];

export function createGame(opts: GameOptions): GameState {
  const state: GameState = {
    mode: opts.mode,
    tick: 0,
    durationTicks: opts.mode === 'versus' ? Math.round((opts.durationSec ?? C.DEFAULT_DURATION_SEC) * C.TICK_RATE) : 0,
    wave: 0,
    waveTimer: 0,
    ships: [],
    bullets: [],
    rocks: [],
    ufo: null,
    ufoTimer: 0,
    nextId: 1,
    rng: { seed: opts.seed ?? (Math.random() * 2 ** 31) | 0 },
    over: false,
    events: [],
  };
  for (const id of opts.players) {
    const ship = newShip(id);
    placeShip(state, ship);
    state.ships.push(ship);
  }
  state.ufoTimer = randRange(state.rng, C.UFO_SPAWN_MIN, C.UFO_SPAWN_MAX);
  startWave(state);
  return state;
}

function newShip(id: number): Ship {
  return {
    id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    alive: true,
    respawnTimer: 0,
    invulnTimer: C.SHIP_INVULN_TIME,
    fireCooldown: 0,
    hyperCooldown: 0,
    thrusting: false,
    score: 0,
    lives: C.SOLO_LIVES,
    nextExtraLife: C.EXTRA_LIFE_EVERY,
  };
}

function placeShip(state: GameState, ship: Ship): void {
  if (state.mode === 'solo') {
    ship.x = C.WORLD_W / 2;
    ship.y = C.WORLD_H / 2;
  } else {
    const [px, py] = SPAWN_POINTS[ship.id % SPAWN_POINTS.length];
    ship.x = C.WORLD_W * px;
    ship.y = C.WORLD_H * py;
  }
  ship.vx = 0;
  ship.vy = 0;
  ship.angle = -Math.PI / 2;
}

export function removeShip(state: GameState, id: number): void {
  state.ships = state.ships.filter((s) => s.id !== id);
  state.bullets = state.bullets.filter((b) => b.owner !== id);
}

// ---- 幾何 ----

export function wrap(v: number, max: number): number {
  return ((v % max) + max) % max;
}

// 画面端ループを考慮した距離の二乗
export function wrappedDist2(ax: number, ay: number, bx: number, by: number): number {
  let dx = Math.abs(ax - bx);
  let dy = Math.abs(ay - by);
  if (dx > C.WORLD_W / 2) dx = C.WORLD_W - dx;
  if (dy > C.WORLD_H / 2) dy = C.WORLD_H - dy;
  return dx * dx + dy * dy;
}

function hits(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const r = ar + br;
  return wrappedDist2(ax, ay, bx, by) < r * r;
}

// ---- 生成 ----

function spawnRock(state: GameState, size: number, x: number, y: number, baseVx = 0, baseVy = 0): Rock {
  const [smin, smax] = C.ROCK_SPEED[size];
  const dir = randRange(state.rng, 0, Math.PI * 2);
  const speed = randRange(state.rng, smin, smax);
  const rock: Rock = {
    id: state.nextId++,
    size,
    x,
    y,
    vx: Math.cos(dir) * speed + baseVx * 0.3,
    vy: Math.sin(dir) * speed + baseVy * 0.3,
    angle: randRange(state.rng, 0, Math.PI * 2),
    spin: randRange(state.rng, -1.2, 1.2),
  };
  state.rocks.push(rock);
  return rock;
}

function startWave(state: GameState): void {
  state.wave++;
  const extra = state.mode === 'versus' ? state.ships.length - 1 : 0;
  const count = Math.min(4 + (state.wave - 1) * 2 + extra, C.MAX_WAVE_ROCKS);
  for (let i = 0; i < count; i++) {
    // 船から離れた位置に出現させる
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 30; tries++) {
      x = randRange(state.rng, 0, C.WORLD_W);
      y = randRange(state.rng, 0, C.WORLD_H);
      if (state.ships.every((s) => wrappedDist2(x, y, s.x, s.y) > 220 * 220)) break;
    }
    spawnRock(state, 3, x, y);
  }
}

function spawnUfo(state: GameState): void {
  const progress = state.mode === 'versus' ? state.tick / Math.max(1, state.durationTicks) : state.wave / 6;
  const small = nextRandom(state.rng) < Math.min(0.8, 0.2 + progress * 0.6);
  const kind = small ? 'small' : 'large';
  const fromLeft = nextRandom(state.rng) < 0.5;
  const r = C.UFO_RADIUS[kind];
  const speed = C.UFO_SPEED[kind];
  state.ufo = {
    id: state.nextId++,
    small,
    x: fromLeft ? -r : C.WORLD_W + r,
    y: randRange(state.rng, C.WORLD_H * 0.1, C.WORLD_H * 0.9),
    vx: fromLeft ? speed : -speed,
    vy: 0,
    fireTimer: C.UFO_FIRE_INTERVAL[kind],
    turnTimer: randRange(state.rng, 0.8, 2),
  };
}

// ---- 破壊処理 ----

function awardPoints(state: GameState, id: number, points: number): void {
  const ship = state.ships.find((s) => s.id === id);
  if (!ship) return;
  ship.score += points;
  if (state.mode === 'solo') {
    while (ship.score >= ship.nextExtraLife) {
      ship.lives++;
      ship.nextExtraLife += C.EXTRA_LIFE_EVERY;
      state.events.push({ k: 'life', o: ship.id });
    }
  }
}

function destroyRock(state: GameState, rock: Rock, by: number): void {
  const idx = state.rocks.indexOf(rock);
  if (idx < 0) return;
  state.rocks.splice(idx, 1);
  state.events.push({ k: 'boom', x: rock.x, y: rock.y, s: rock.size, c: -1 });
  if (by >= 0) awardPoints(state, by, C.ROCK_POINTS[rock.size]);
  if (rock.size > 1) {
    for (let i = 0; i < 2; i++) spawnRock(state, rock.size - 1, rock.x, rock.y, rock.vx, rock.vy);
  }
}

function destroyUfo(state: GameState, by: number): void {
  const ufo = state.ufo;
  if (!ufo) return;
  state.ufo = null;
  state.ufoTimer = randRange(state.rng, C.UFO_SPAWN_MIN, C.UFO_SPAWN_MAX);
  state.events.push({ k: 'boom', x: ufo.x, y: ufo.y, s: 2, c: -2 });
  if (by >= 0) awardPoints(state, by, ufo.small ? C.UFO_POINTS.small : C.UFO_POINTS.large);
}

function destroyShip(state: GameState, ship: Ship, killer: number): void {
  if (!ship.alive) return;
  ship.alive = false;
  ship.thrusting = false;
  ship.respawnTimer = C.SHIP_RESPAWN_TIME;
  state.events.push({ k: 'boom', x: ship.x, y: ship.y, s: 3, c: ship.id });
  state.events.push({ k: 'kill', killer, victim: ship.id });
  if (killer >= 0 && killer !== ship.id) awardPoints(state, killer, C.PLAYER_KILL_POINTS);
  if (state.mode === 'solo') {
    ship.lives--;
    if (ship.lives <= 0) state.over = true;
  }
}

function vulnerable(ship: Ship): boolean {
  return ship.alive && ship.invulnTimer <= 0;
}

// ---- 1ティック更新 ----

/** inputs[slot] に各プレイヤーの入力ビットを渡す */
export function step(state: GameState, inputs: ArrayLike<number>): void {
  state.events = [];
  if (state.over) return;
  const dt = C.DT;
  state.tick++;

  for (const ship of state.ships) updateShip(state, ship, inputs[ship.id] ?? 0, dt);
  updateBullets(state, dt);
  for (const rock of state.rocks) {
    rock.x = wrap(rock.x + rock.vx * dt, C.WORLD_W);
    rock.y = wrap(rock.y + rock.vy * dt, C.WORLD_H);
    rock.angle += rock.spin * dt;
  }
  updateUfo(state, dt);
  collide(state);

  // ウェーブ進行
  if (state.rocks.length === 0) {
    if (state.waveTimer <= 0) state.waveTimer = C.WAVE_DELAY;
    state.waveTimer -= dt;
    if (state.waveTimer <= 0) startWave(state);
  }

  if (state.mode === 'versus' && state.tick >= state.durationTicks) state.over = true;
}

function updateShip(state: GameState, ship: Ship, input: number, dt: number): void {
  if (!ship.alive) {
    if (state.mode === 'solo' && ship.lives <= 0) return;
    ship.respawnTimer -= dt;
    if (ship.respawnTimer <= 0) {
      placeShip(state, ship);
      ship.alive = true;
      ship.invulnTimer = C.SHIP_INVULN_TIME;
    }
    return;
  }
  ship.invulnTimer = Math.max(0, ship.invulnTimer - dt);
  ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
  ship.hyperCooldown = Math.max(0, ship.hyperCooldown - dt);

  if (input & C.IN_LEFT) ship.angle -= C.SHIP_TURN_SPEED * dt;
  if (input & C.IN_RIGHT) ship.angle += C.SHIP_TURN_SPEED * dt;
  ship.thrusting = (input & C.IN_THRUST) !== 0;
  if (ship.thrusting) {
    ship.vx += Math.cos(ship.angle) * C.SHIP_THRUST * dt;
    ship.vy += Math.sin(ship.angle) * C.SHIP_THRUST * dt;
  }
  const drag = Math.exp(-C.SHIP_DRAG * dt);
  ship.vx *= drag;
  ship.vy *= drag;
  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > C.SHIP_MAX_SPEED) {
    ship.vx *= C.SHIP_MAX_SPEED / speed;
    ship.vy *= C.SHIP_MAX_SPEED / speed;
  }
  ship.x = wrap(ship.x + ship.vx * dt, C.WORLD_W);
  ship.y = wrap(ship.y + ship.vy * dt, C.WORLD_H);

  if (input & C.IN_FIRE && ship.fireCooldown <= 0) {
    const own = state.bullets.reduce((n, b) => n + (b.owner === ship.id ? 1 : 0), 0);
    if (own < C.SHIP_MAX_BULLETS) {
      const cos = Math.cos(ship.angle);
      const sin = Math.sin(ship.angle);
      state.bullets.push({
        id: state.nextId++,
        owner: ship.id,
        x: wrap(ship.x + cos * C.SHIP_RADIUS, C.WORLD_W),
        y: wrap(ship.y + sin * C.SHIP_RADIUS, C.WORLD_H),
        vx: cos * C.BULLET_SPEED + ship.vx,
        vy: sin * C.BULLET_SPEED + ship.vy,
        life: C.BULLET_LIFE,
      });
      ship.fireCooldown = C.SHIP_FIRE_COOLDOWN;
      state.events.push({ k: 'fire', o: ship.id });
    }
  }

  if (input & C.IN_HYPER && ship.hyperCooldown <= 0) {
    ship.hyperCooldown = C.HYPER_COOLDOWN;
    state.events.push({ k: 'hyper', o: ship.id, x: ship.x, y: ship.y });
    ship.x = randRange(state.rng, 0, C.WORLD_W);
    ship.y = randRange(state.rng, 0, C.WORLD_H);
    ship.vx = 0;
    ship.vy = 0;
    if (nextRandom(state.rng) < C.HYPER_FAIL_CHANCE && ship.invulnTimer <= 0) destroyShip(state, ship, -1);
  }
}

function updateBullets(state: GameState, dt: number): void {
  const alive: Bullet[] = [];
  for (const b of state.bullets) {
    b.life -= dt;
    if (b.life <= 0) continue;
    b.x = wrap(b.x + b.vx * dt, C.WORLD_W);
    b.y = wrap(b.y + b.vy * dt, C.WORLD_H);
    alive.push(b);
  }
  state.bullets = alive;
}

function updateUfo(state: GameState, dt: number): void {
  const ufo = state.ufo;
  if (!ufo) {
    state.ufoTimer -= dt;
    if (state.ufoTimer <= 0) spawnUfo(state);
    return;
  }
  const kind = ufo.small ? 'small' : 'large';
  ufo.turnTimer -= dt;
  if (ufo.turnTimer <= 0) {
    ufo.turnTimer = randRange(state.rng, 0.8, 2);
    const r = nextRandom(state.rng);
    ufo.vy = r < 0.33 ? -Math.abs(ufo.vx) * 0.6 : r < 0.66 ? 0 : Math.abs(ufo.vx) * 0.6;
  }
  ufo.x += ufo.vx * dt;
  ufo.y = wrap(ufo.y + ufo.vy * dt, C.WORLD_H);
  const r = C.UFO_RADIUS[kind];
  if ((ufo.vx > 0 && ufo.x > C.WORLD_W + r) || (ufo.vx < 0 && ufo.x < -r)) {
    // 画面外へ去った
    state.ufo = null;
    state.ufoTimer = randRange(state.rng, C.UFO_SPAWN_MIN, C.UFO_SPAWN_MAX);
    return;
  }
  ufo.fireTimer -= dt;
  if (ufo.fireTimer <= 0 && ufo.x > 0 && ufo.x < C.WORLD_W) {
    ufo.fireTimer = C.UFO_FIRE_INTERVAL[kind];
    fireUfo(state, ufo);
  }
}

function fireUfo(state: GameState, ufo: Ufo): void {
  let dir = randRange(state.rng, 0, Math.PI * 2);
  if (ufo.small) {
    // 小UFOは最寄りの船を狙う（多少の誤差あり）
    let best: Ship | null = null;
    let bestD = Infinity;
    for (const s of state.ships) {
      if (!s.alive) continue;
      const d = wrappedDist2(ufo.x, ufo.y, s.x, s.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) dir = Math.atan2(best.y - ufo.y, best.x - ufo.x) + randRange(state.rng, -0.2, 0.2);
  }
  state.bullets.push({
    id: state.nextId++,
    owner: -1,
    x: ufo.x,
    y: ufo.y,
    vx: Math.cos(dir) * C.UFO_BULLET_SPEED,
    vy: Math.sin(dir) * C.UFO_BULLET_SPEED,
    life: C.BULLET_LIFE * 1.3,
  });
  state.events.push({ k: 'fire', o: -1 });
}

function collide(state: GameState): void {
  // 弾 vs 小惑星 / UFO / 船
  for (const b of [...state.bullets]) {
    let hit = false;
    for (const rock of state.rocks) {
      if (hits(b.x, b.y, 0, rock.x, rock.y, C.ROCK_RADIUS[rock.size])) {
        destroyRock(state, rock, b.owner);
        hit = true;
        break;
      }
    }
    if (!hit && b.owner >= 0 && state.ufo) {
      const ufo = state.ufo;
      if (hits(b.x, b.y, 0, ufo.x, ufo.y, ufo.small ? C.UFO_RADIUS.small : C.UFO_RADIUS.large)) {
        destroyUfo(state, b.owner);
        hit = true;
      }
    }
    if (!hit) {
      for (const ship of state.ships) {
        if (ship.id === b.owner || !vulnerable(ship)) continue;
        if (hits(b.x, b.y, 0, ship.x, ship.y, C.SHIP_RADIUS)) {
          destroyShip(state, ship, b.owner);
          hit = true;
          break;
        }
      }
    }
    if (hit) state.bullets = state.bullets.filter((x) => x !== b);
  }

  // 船 vs 小惑星 / UFO / 他の船
  for (const ship of state.ships) {
    if (!vulnerable(ship)) continue;
    for (const rock of state.rocks) {
      if (hits(ship.x, ship.y, C.SHIP_RADIUS, rock.x, rock.y, C.ROCK_RADIUS[rock.size])) {
        destroyRock(state, rock, ship.id);
        destroyShip(state, ship, -1);
        break;
      }
    }
    if (!ship.alive) continue;
    const ufo = state.ufo;
    if (ufo && hits(ship.x, ship.y, C.SHIP_RADIUS, ufo.x, ufo.y, ufo.small ? C.UFO_RADIUS.small : C.UFO_RADIUS.large)) {
      destroyUfo(state, ship.id);
      destroyShip(state, ship, -1);
      continue;
    }
    for (const other of state.ships) {
      if (other === ship || !vulnerable(other)) continue;
      if (hits(ship.x, ship.y, C.SHIP_RADIUS, other.x, other.y, C.SHIP_RADIUS)) {
        destroyShip(state, ship, -1);
        destroyShip(state, other, -1);
        break;
      }
    }
  }

  // UFO vs 小惑星
  const ufo = state.ufo;
  if (ufo) {
    const r = ufo.small ? C.UFO_RADIUS.small : C.UFO_RADIUS.large;
    for (const rock of state.rocks) {
      if (hits(ufo.x, ufo.y, r, rock.x, rock.y, C.ROCK_RADIUS[rock.size])) {
        destroyRock(state, rock, -1);
        destroyUfo(state, -1);
        break;
      }
    }
  }
}

export function timeLeftSec(state: GameState): number {
  if (state.mode !== 'versus') return 0;
  return Math.max(0, (state.durationTicks - state.tick) / C.TICK_RATE);
}
