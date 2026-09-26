// Web Audio API で効果音をその場で合成する（音声ファイル不要）
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private thrustGain: GainNode | null = null;
  private ufoGain: GainNode | null = null;
  private ufoOsc: OscillatorNode | null = null;
  muted = false;

  /** ユーザー操作（クリック/タップ）の中で呼ぶ必要がある */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.35;
      this.master.connect(ctx.destination);

      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      // 推進音：ループするノイズ
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      this.thrustGain = ctx.createGain();
      this.thrustGain.gain.value = 0;
      src.connect(lp).connect(this.thrustGain).connect(this.master);
      src.start();

      // UFO音：周波数を揺らす矩形波
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 420;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 6;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 80;
      lfo.connect(lfoGain).connect(osc.frequency);
      this.ufoGain = ctx.createGain();
      this.ufoGain.gain.value = 0;
      osc.connect(this.ufoGain).connect(this.master);
      osc.start();
      lfo.start();
      this.ufoOsc = osc;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.35, this.ctx.currentTime, 0.02);
  }

  fire(local: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.1);
    g.gain.setValueAtTime(local ? 0.25 : 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  boom(size: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400 / size;
    const g = ctx.createGain();
    const dur = 0.2 + size * 0.15;
    g.gain.setValueAtTime(0.5 + size * 0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  blip(freq: number, dur = 0.15): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  setThrust(on: boolean): void {
    if (this.thrustGain && this.ctx) this.thrustGain.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.03);
  }

  setUfo(state: 'none' | 'large' | 'small'): void {
    if (!this.ufoGain || !this.ctx || !this.ufoOsc) return;
    this.ufoGain.gain.setTargetAtTime(state === 'none' ? 0 : 0.05, this.ctx.currentTime, 0.05);
    if (state !== 'none') this.ufoOsc.frequency.setTargetAtTime(state === 'small' ? 900 : 420, this.ctx.currentTime, 0.05);
  }

  silence(): void {
    this.setThrust(false);
    this.setUfo('none');
  }
}
