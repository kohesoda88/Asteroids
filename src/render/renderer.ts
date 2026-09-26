import { PLAYER_COLORS, ROCK_RADIUS, SHIP_RADIUS, UFO_COLOR, UFO_RADIUS, VIEW_SIZE, WORLD_H, WORLD_W } from '../core/constants';
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

interface Camera {
  x: number;
  y: number;
  a: number; // 自機の向き。この向きが画面の上になる
}

interface Star {
  x: number;
  y: number;
  c: number; // 明るさの段階
}

const ROCK_COLOR = '#d8dde8';
const STAR_COLORS = ['#3a4458', '#525e78', '#707d9a'];
const STARS_PER_VIEW = 150;
// 画面中心から四隅までの距離。これより遠い物体は描かない
const CULL_RADIUS = (VIEW_SIZE / 2) * Math.SQRT2;
const RADAR_RADIUS = 64;

function colorOf(c: number): string {
  if (c >= 0) return PLAYER_COLORS[c % PLAYER_COLORS.length];
  return c === -2 ? UFO_COLOR : ROCK_COLOR;
}

/** フィールドの端のループを考慮した、最も近い向きの差分 */
function wrapDelta(d: number, size: number): number {
  d %= size;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private size = 0; // 正方形の画面の一辺（CSS px）
  private offX = 0;
  private offY = 0;
  private particles: Particle[] = [];
  private rockShapes = new Map<number, [number, number][]>();
  private stars: Star[] = [];
  private cam: Camera = { x: WORLD_W / 2, y: WORLD_H / 2, a: -Math.PI / 2 };
  private time = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    // 背景の星（フィールドに固定。全員が同じ星空を見る）
    const rnd = hashRandom(20260926);
    const n = Math.round(STARS_PER_VIEW * ((WORLD_W * WORLD_H) / (VIEW_SIZE * VIEW_SIZE)));
    for (let i = 0; i < n; i++) this.stars.push({ x: rnd() * WORLD_W, y: rnd() * WORLD_H, c: Math.floor(rnd() * STAR_COLORS.length) });
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
    this.size = Math.min(w, h);
    this.offX = (w - this.size) / 2;
    // 縦長では正方形を上寄せにし、下の余白をタッチボタンに使う（上に音声・終了ボタンの分だけ空ける）
    this.offY = h > w ? Math.min((h - this.size) / 2, 52) : (h - this.size) / 2;
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
      if (this.rockShapes.size > 800) this.rockShapes.delete(this.rockShapes.keys().next().value!);
    }
    return shape;
  }

  /** カメラから見た位置（フィールドのループを考慮）。画面外なら null */
  private rel(x: number, y: number, r: number): [number, number] | null {
    const dx = wrapDelta(x - this.cam.x, WORLD_W);
    const dy = wrapDelta(y - this.cam.y, WORLD_H);
    const lim = CULL_RADIUS + r;
    if (dx * dx + dy * dy > lim * lim) return null;
    return [dx, dy];
  }

  draw(view: View, names: string[], localId: number, dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    const k = this.size / VIEW_SIZE; // 論理単位 → CSS px

    // カメラ：自機が生きていれば追従、撃破中は最後の位置と向きのまま
    const me = view.ships.find((s) => s.id === localId);
    if (me && me.alive) this.cam = { x: me.x, y: me.y, a: me.a };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 正方形の画面の中心を原点に、前方が上になるよう回転した座標系
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * (this.offX + this.size / 2), this.dpr * (this.offY + this.size / 2));
    ctx.save();
    ctx.beginPath();
    ctx.rect(-VIEW_SIZE / 2, -VIEW_SIZE / 2, VIEW_SIZE, VIEW_SIZE);
    ctx.clip();
    ctx.fillStyle = '#03050a';
    ctx.fillRect(-VIEW_SIZE / 2, -VIEW_SIZE / 2, VIEW_SIZE, VIEW_SIZE);
    ctx.rotate(-Math.PI / 2 - this.cam.a);

    // 背景の星
    for (let c = 0; c < STAR_COLORS.length; c++) {
      ctx.fillStyle = STAR_COLORS[c];
      for (const s of this.stars) {
        if (s.c !== c) continue;
        const p = this.rel(s.x, s.y, 2);
        if (p) ctx.fillRect(p[0] - 1.2, p[1] - 1.2, 2.4, 2.4);
      }
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 小惑星
    ctx.strokeStyle = ROCK_COLOR;
    ctx.lineWidth = 2;
    for (const r of view.rocks) {
      const p = this.rel(r.x, r.y, ROCK_RADIUS[r.s]);
      if (!p) continue;
      const shape = this.rockShape(r.id, r.s);
      const cos = Math.cos(r.a);
      const sin = Math.sin(r.a);
      ctx.beginPath();
      shape.forEach(([sx, sy], i) => {
        const px = p[0] + sx * cos - sy * sin;
        const py = p[1] + sx * sin + sy * cos;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }

    // UFO
    if (view.ufo) {
      const u = view.ufo;
      const r = u.small ? UFO_RADIUS.small : UFO_RADIUS.large;
      const p = this.rel(u.x, u.y, r * 1.5);
      if (p) {
        ctx.strokeStyle = UFO_COLOR;
        ctx.lineWidth = 2;
        this.drawUfo(p[0], p[1], r);
      }
    }

    // 弾
    for (const b of view.bullets) {
      const p = this.rel(b.x, b.y, 3);
      if (!p) continue;
      ctx.fillStyle = b.o >= 0 ? PLAYER_COLORS[b.o % PLAYER_COLORS.length] : UFO_COLOR;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 船
    for (const s of view.ships) {
      if (!s.alive) continue;
      if (s.inv && Math.floor(this.time * 8) % 2 === 0) continue; // 無敵中は点滅
      const p = this.rel(s.x, s.y, SHIP_RADIUS * 2);
      if (p) this.drawShip(s, p[0], p[1], s.id === localId);
    }

    // パーティクル
    const alive: Particle[] = [];
    for (const pt of this.particles) {
      pt.life -= dt;
      if (pt.life <= 0) continue;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      alive.push(pt);
      const p = this.rel(pt.x, pt.y, 2);
      if (!p) continue;
      ctx.globalAlpha = pt.life / pt.max;
      ctx.fillStyle = pt.color;
      ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    this.particles = alive;
    ctx.restore();

    // 画面の枠
    ctx.strokeStyle = '#1b2233';
    ctx.lineWidth = 2;
    ctx.strokeRect(-VIEW_SIZE / 2, -VIEW_SIZE / 2, VIEW_SIZE, VIEW_SIZE);

    // 以降は回転しない HUD（左上が原点の 0〜VIEW_SIZE 座標）
    ctx.translate(-VIEW_SIZE / 2, -VIEW_SIZE / 2);
    this.drawHud(view, names, localId);
    if (view.mode === 'versus' && view.ships.length > 0) this.drawRadar(view, localId);
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

  /** レーダー：フィールド全体を自機中心・前方が上で縮小表示し、相手プレイヤーの位置を示す */
  private drawRadar(view: View, localId: number): void {
    const ctx = this.ctx;
    const cx = VIEW_SIZE - RADAR_RADIUS - 14;
    const cy = VIEW_SIZE - RADAR_RADIUS - 14;
    const scale = RADAR_RADIUS / (WORLD_W / 2);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(8, 14, 26, 0.75)';
    ctx.strokeStyle = '#2a3450';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, RADAR_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.clip();
    // 画面に見えている範囲
    ctx.strokeStyle = '#34405e';
    const v = (VIEW_SIZE / 2) * scale;
    ctx.strokeRect(-v, -v, v * 2, v * 2);
    ctx.rotate(-Math.PI / 2 - this.cam.a);
    for (const s of view.ships) {
      if (s.id === localId || !s.alive) continue;
      let dx = wrapDelta(s.x - this.cam.x, WORLD_W) * scale;
      let dy = wrapDelta(s.y - this.cam.y, WORLD_H) * scale;
      const d = Math.hypot(dx, dy);
      const max = RADAR_RADIUS - 5;
      if (d > max) {
        dx *= max / d;
        dy *= max / d;
      }
      ctx.fillStyle = PLAYER_COLORS[s.id % PLAYER_COLORS.length];
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // 自機（中心・上向き）
    ctx.fillStyle = PLAYER_COLORS[localId % PLAYER_COLORS.length] ?? '#fff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.closePath();
    ctx.fill();
  }

  private drawHud(view: View, names: string[], localId: number): void {
    if (view.ships.length === 0) return;
    const ctx = this.ctx;
    ctx.textBaseline = 'top';

    if (view.mode === 'solo') {
      const s = view.ships[0];
      if (s) {
        ctx.font = 'bold 24px "Courier New", monospace';
        ctx.fillStyle = PLAYER_COLORS[0];
        ctx.textAlign = 'left';
        ctx.fillText(String(s.score), 16, 14);
        // 残機
        ctx.strokeStyle = PLAYER_COLORS[0];
        ctx.lineWidth = 1.5;
        for (let i = 0; i < Math.min(s.lives, 10); i++) {
          const x = 26 + i * 22;
          const y = 58;
          ctx.beginPath();
          ctx.moveTo(x, y - 10);
          ctx.lineTo(x - 7, y + 8);
          ctx.lineTo(x, y + 4);
          ctx.lineTo(x + 7, y + 8);
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.font = 'bold 22px "Courier New", monospace';
      ctx.fillStyle = '#8894aa';
      ctx.textAlign = 'right';
      ctx.fillText(`WAVE ${view.wave}`, VIEW_SIZE - 16, 14);
      return;
    }

    // 対戦：各プレイヤーのスコアを上部に並べ、残り時間を右上に出す
    const sorted = [...view.ships].sort((a, b) => a.id - b.id);
    const colW = Math.min(160, (VIEW_SIZE - 130) / Math.max(1, sorted.length));
    sorted.forEach((s, i) => {
      const x = 14 + i * colW;
      ctx.fillStyle = PLAYER_COLORS[s.id % PLAYER_COLORS.length];
      ctx.textAlign = 'left';
      ctx.font = `${s.id === localId ? 'bold ' : ''}16px "Courier New", monospace`;
      ctx.fillText(((s.id === localId ? '▶' : '') + (names[s.id] ?? `P${s.id + 1}`)).slice(0, 10), x, 10);
      ctx.font = 'bold 22px "Courier New", monospace';
      ctx.fillText(String(s.score), x, 30);
    });
    const t = Math.ceil(view.timeLeft);
    ctx.fillStyle = t <= 10 ? '#ff5f5f' : '#e8ecf5';
    ctx.textAlign = 'right';
    ctx.font = 'bold 26px "Courier New", monospace';
    ctx.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, VIEW_SIZE - 14, 12);
  }
}
