import { IN_FIRE, IN_HYPER, IN_LEFT, IN_RIGHT, IN_THRUST } from '../core/constants';

const KEY_MAP: Record<string, number> = {
  ArrowLeft: IN_LEFT,
  KeyA: IN_LEFT,
  ArrowRight: IN_RIGHT,
  KeyD: IN_RIGHT,
  ArrowUp: IN_THRUST,
  KeyW: IN_THRUST,
  Space: IN_FIRE,
  KeyJ: IN_FIRE,
  ArrowDown: IN_HYPER,
  KeyS: IN_HYPER,
};

const HOLD_MS = 500; // この時間 fire ボタンを押し続けると連射ホールド

/** キーボードとタッチボタンの入力をまとめて入力ビットにする */
export class Input {
  private keys = 0;
  private touch = new Map<number, number>(); // pointerId -> ビット
  private latched = 0; // 次の読み取りまで保持する（1フレーム未満の短い押下を取りこぼさない）
  private autoFire = false; // スマホ：fire ボタン長押しで連射をホールド
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private _enabled = false;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
    // ゲーム外に出たら連射ホールドを解除する
    if (!v && this.autoFire) {
      this.autoFire = false;
      this.refreshButtons(this.touchRoot);
    }
  }

  constructor(private touchRoot: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const bit = KEY_MAP[e.code];
      if (bit === undefined || !this.enabled) return;
      e.preventDefault();
      this.keys |= bit;
      this.latched |= bit;
    });
    window.addEventListener('keyup', (e) => {
      const bit = KEY_MAP[e.code];
      if (bit !== undefined) this.keys &= ~bit;
    });
    window.addEventListener('blur', () => {
      this.keys = 0;
      this.touch.clear();
      this.refreshButtons(touchRoot);
    });

    // タッチ：ボタン上で押した指はそのボタンに割り当て、指をずらしたら上にあるボタンへ移る
    const bitAt = (x: number, y: number): number => {
      const el = document.elementFromPoint(x, y);
      const btn = el instanceof HTMLElement ? el.closest<HTMLElement>('[data-bit]') : null;
      return btn && touchRoot.contains(btn) ? Number(btn.dataset.bit) : 0;
    };
    const update = (e: PointerEvent) => {
      if (!this.touch.has(e.pointerId)) return;
      e.preventDefault();
      this.touch.set(e.pointerId, bitAt(e.clientX, e.clientY));
      this.refreshButtons(touchRoot);
    };
    touchRoot.addEventListener('pointerdown', (e) => {
      const bit = bitAt(e.clientX, e.clientY);
      if (!bit) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      this.touch.set(e.pointerId, bit);
      this.latched |= bit;
      if (bit === IN_FIRE) this.onFireDown(e.pointerId);
      this.refreshButtons(touchRoot);
    });
    touchRoot.addEventListener('pointermove', update);
    const end = (e: PointerEvent) => {
      this.touch.delete(e.pointerId);
      this.refreshButtons(touchRoot);
    };
    touchRoot.addEventListener('pointerup', end);
    touchRoot.addEventListener('pointercancel', end);
    touchRoot.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 連射ホールド：OFF のとき長押しで ON、ON のときは押した時点で OFF */
  private onFireDown(pointerId: number): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.autoFire) {
      this.autoFire = false;
      return;
    }
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.touch.get(pointerId) === IN_FIRE && this._enabled) {
        this.autoFire = true;
        navigator.vibrate?.(30);
        this.refreshButtons(this.touchRoot);
      }
    }, HOLD_MS);
  }

  private refreshButtons(root: HTMLElement): void {
    const active = this.touchBits();
    root.querySelectorAll<HTMLElement>('[data-bit]').forEach((b) => {
      const bit = Number(b.dataset.bit);
      b.classList.toggle('active', (active & bit) !== 0);
      if (bit === IN_FIRE) b.classList.toggle('latched', this.autoFire);
    });
  }

  private touchBits(): number {
    let bits = 0;
    for (const b of this.touch.values()) bits |= b;
    return bits;
  }

  bits(): number {
    const bits = this.keys | this.touchBits() | this.latched | (this.autoFire ? IN_FIRE : 0);
    this.latched = 0;
    return this.enabled ? bits : 0;
  }
}
