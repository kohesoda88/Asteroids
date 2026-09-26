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

/** キーボードとタッチボタンの入力をまとめて入力ビットにする */
export class Input {
  private keys = 0;
  private touch = new Map<number, number>(); // pointerId -> ビット
  private latched = 0; // 次の読み取りまで保持する（1フレーム未満の短い押下を取りこぼさない）
  enabled = false;

  constructor(touchRoot: HTMLElement) {
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

  private refreshButtons(root: HTMLElement): void {
    const active = this.touchBits();
    root.querySelectorAll<HTMLElement>('[data-bit]').forEach((b) => {
      b.classList.toggle('active', (active & Number(b.dataset.bit)) !== 0);
    });
  }

  private touchBits(): number {
    let bits = 0;
    for (const b of this.touch.values()) bits |= b;
    return bits;
  }

  bits(): number {
    const bits = this.keys | this.touchBits() | this.latched;
    this.latched = 0;
    return this.enabled ? bits : 0;
  }
}
