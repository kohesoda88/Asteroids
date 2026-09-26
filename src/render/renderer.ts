import { PLAYER_COLORS, ROCK_RADIUS, SHIP_RADIUS, UFO_COLOR, UFO_RADIUS, WORLD_H, WORLD_W } from '../core/constants';
import { hashRandom } from '../core/rng';
import type { GameEvent } from '../core/types';
import type { View, ViewShip } from '../core/view';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

const ROCK_COLOR = '#d8dde8';

function colorOf(c: number): string {
  if (c >= 0) return PLAYER_COLORS[c % PLAYER_COLORS.length];
  return c === -2 ? UFO_COLOR : ROCK_COLOR;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dpr = 1;
  private particles: Particle[] = [];
  private rockShapes = new Map<number, [number, number][]>();
  private time = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.scale = Math.min(w / WORLD_W, h / WORLD_H);
    this.offX = (w - WORLD_W * this.scale) / 2;
    this.offY = (h - WORLD_H * this.scale) / 2;
  }

  addEffects(events: GameEvent[]): void {
    for (const e of events) {
      if (e.k === 'boom') {
        const n = 6 + e.s * 6;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 40 + Math.random() * 90 * e.s;
          const life = 0.4 + Math.random() * 0.6;
          this.particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, color: colorOf(e.c) });
        }
      } else if (e.k === 'hyper') {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          this.particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, life: 0.3, max: 0.3, color: colorOf(e.o) });
        }
      }
    }
  }

  private rockShape(id: number, size: number): [number, number][] {
    let shape = this.rockShapes.get(id);
    if (!shape) {
      const rnd = hashRandom(id);
      const n = 9 + Math.floor(rnd() * 4);
      const r = ROCK_RADIUS[size];
      shape = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (0.72 + rnd() * 0.38);
        shape.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      this.rockShapes.set(id, shape);
      if (this.rockShapes.size > 500) this.rockShapes.delete(this.rockShapes.keys().next().value!);
    }
    return shape;
  }

  /** 画面端をまたぐ物体を反対側にも描画する */
  private wrapped(x: number, y: number, r: number, draw: (x: number, y: number) => void): void {
    const xs = [x];
    const ys = [y];
    if (x < r) xs.push(x + WORLD_W);
    else if (x > WORLD_W - r) xs.push(x - WORLD_W);
    if (y < r) ys.push(y + WORLD_H);
    else if (y > WORLD_H - r) ys.push(y - WORLD_H);
    for (const px of xs) for (const py of ys) draw(px, py);
  }

  draw(view: View, names: string[], localId: number, dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale * this.dpr, 0, 0, this.scale * this.dpr, this.offX * this.dpr, this.offY * this.dpr);

    // ワールド外枠
    ctx.strokeStyle = '#1b2233';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_W, WORLD_H);
    ctx.clip();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 小惑星
    ctx.strokeStyle = ROCK_COLOR;
    ctx.lineWidth = 2;
    for (const r of view.rocks) {
      const shape = this.rockShape(r.id, r.s);
      this.wrapped(r.x, r.y, ROCK_RADIUS[r.s] * 1.1, (x, y) => {
        ctx.beginPath();
        const cos = Math.cos(r.a);
        const sin = Math.sin(r.a);
        shape.forEach(([sx, sy], i) => {
          const px = x + sx * cos - sy * sin;
          const py = y + sx * sin + sy * cos;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
      });
    }

    // UFO
    if (view.ufo) {
      const u = view.ufo;
      const r = u.small ? UFO_RADIUS.small : UFO_RADIUS.large;
      ctx.strokeStyle = UFO_COLOR;
      ctx.lineWidth = 2;
      this.wrapped(u.x, u.y, r * 1.5, (x, y) => this.drawUfo(x, y, r));
    }

    // 弾
    for (const b of view.bullets) {
      ctx.fillStyle = b.o >= 0 ? PLAYER_COLORS[b.o % PLAYER_COLORS.length] : UFO_COLOR;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 船
    for (const s of view.ships) {
      if (!s.alive) continue;
      if (s.inv && Math.floor(this.time * 8) % 2 === 0) continue; // 無敵中は点滅
      this.wrapped(s.x, s.y, SHIP_RADIUS * 2, (x, y) => this.drawShip(s, x, y, s.id === localId));
    }

    // パーティクル
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      alive.push(p);
    }
    ctx.globalAlpha = 1;
    this.particles = alive;
    ctx.restore();

    this.drawHud(view, names, localId);
  }

  private drawShip(s: ViewShip, x: number, y: number, local: boolean): void {
    const ctx = this.ctx;
    const color = PLAYER_COLORS[s.id % PLAYER_COLORS.length];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(s.a);
    ctx.strokeStyle = color;
    ctx.lineWidth = local ? 2.5 : 2;
    const r = SHIP_RADIUS;
    ctx.beginPath();
    ctx.moveTo(r * 1.4, 0);
    ctx.lineTo(-r, -r * 0.85);
    ctx.lineTo(-r * 0.6, 0);
    ctx.lineTo(-r, r * 0.85);
    ctx.closePath();
    ctx.stroke();
    if (s.thr && Math.floor(this.time * 30) % 2 === 0) {
      ctx.beginPath();
      ctx.moveTo(-r * 0.7, -r * 0.4);
      ctx.lineTo(-r * 1.6, 0);
      ctx.lineTo(-r * 0.7, r * 0.4);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawUfo(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x - r * 1.5, y);
    ctx.lineTo(x + r * 1.5, y);
    ctx.lineTo(x + r * 0.7, y + r * 0.55);
    ctx.lineTo(x - r * 0.7, y + r * 0.55);
    ctx.closePath();
    ctx.moveTo(x - r * 1.5, y);
    ctx.lineTo(x - r * 0.7, y - r * 0.45);
    ctx.lineTo(x + r * 0.7, y - r * 0.45);
    ctx.lineTo(x + r * 1.5, y);
    ctx.moveTo(x - r * 0.4, y - r * 0.45);
    ctx.lineTo(x - r * 0.25, y - r * 0.9);
    ctx.lineTo(x + r * 0.25, y - r * 0.9);
    ctx.lineTo(x + r * 0.4, y - r * 0.45);
    ctx.stroke();
  }

  private drawHud(view: View, names: string[], localId: number): void {
    if (view.ships.length === 0) return;
    const ctx = this.ctx;
    ctx.font = 'bold 24px "Courier New", monospace';
    ctx.textBaseline = 'top';

    if (view.mode === 'solo') {
      const s = view.ships[0];
      if (s) {
        ctx.fillStyle = PLAYER_COLORS[0];
        ctx.textAlign = 'left';
        ctx.fillText(String(s.score).padStart(6, ' '), 20, 16);
        // 残機
        ctx.strokeStyle = PLAYER_COLORS[0];
        ctx.lineWidth = 1.5;
        for (let i = 0; i < Math.min(s.lives, 10); i++) {
          const x = 36 + i * 22;
          const y = 62;
          ctx.beginPath();
          ctx.moveTo(x, y - 10);
          ctx.lineTo(x - 7, y + 8);
          ctx.lineTo(x, y + 4);
          ctx.lineTo(x + 7, y + 8);
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.fillStyle = '#8894aa';
      ctx.textAlign = 'right';
      ctx.fillText(`WAVE ${view.wave}`, WORLD_W - 20, 16);
      return;
    }

    // 対戦：各プレイヤーのスコアを上部に並べる
    const n = view.ships.length;
    const colW = Math.min(260, (WORLD_W - 200) / Math.max(1, n));
    const sorted = [...view.ships].sort((a, b) => a.id - b.id);
    sorted.forEach((s, i) => {
      const x = 20 + i * colW;
      ctx.fillStyle = PLAYER_COLORS[s.id % PLAYER_COLORS.length];
      ctx.textAlign = 'left';
      ctx.font = `${s.id === localId ? 'bold ' : ''}18px "Courier New", monospace`;
      ctx.fillText((s.id === localId ? '▶' : '') + (names[s.id] ?? `P${s.id + 1}`), x, 12);
      ctx.font = 'bold 24px "Courier New", monospace';
      ctx.fillText(String(s.score), x, 34);
    });
    const t = Math.ceil(view.timeLeft);
    ctx.fillStyle = t <= 10 ? '#ff5f5f' : '#e8ecf5';
    ctx.textAlign = 'right';
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, WORLD_W - 20, 14);
  }
}
