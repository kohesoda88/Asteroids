import './style.css';
import { Sfx } from './audio/sfx';
import { PLAYER_COLORS, TICK_RATE } from './core/constants';
import { createGame, removeShip, step } from './core/sim';
import type { GameEvent, GameState } from './core/types';
import { interpolateView, toView, type View } from './core/view';
import { Input } from './input/input';
import { GuestSession } from './net/client';
import { HostSession, type GuestSlot } from './net/host';
import type { LobbyPlayer } from './net/protocol';
import { Renderer } from './render/renderer';
import { canScan, joinUrl, qrSvg, scanQr, takeJoinCodeFromUrl } from './ui/qr';

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = ['screen-title', 'screen-host', 'screen-guest', 'screen-result'] as const;
type ScreenId = (typeof screens)[number] | null;

function show(id: ScreenId): void {
  for (const s of screens) $(s).classList.toggle('hidden', s !== id);
  const inGame = id === null;
  $('ingame').classList.toggle('hidden', !inGame);
  $('touch').classList.toggle('hidden', !(inGame && isTouch));
  $('portrait-hint').classList.toggle('show', inGame);
  input.enabled = inGame;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const canShare = typeof navigator.share === 'function';
const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------- 設定の保存 ----------
function load(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できない環境では無視
  }
}

const nameInput = $<HTMLInputElement>('name');
const stunInput = $<HTMLInputElement>('stun');
nameInput.value = load('ast.name', 'Player');
stunInput.checked = load('ast.stun', '1') === '1';
nameInput.addEventListener('change', () => save('ast.name', nameInput.value.trim()));
stunInput.addEventListener('change', () => save('ast.stun', stunInput.checked ? '1' : '0'));
const playerName = () => nameInput.value.trim().slice(0, 12) || 'Player';

// ---------- コア ----------
const renderer = new Renderer($<HTMLCanvasElement>('game'));
const input = new Input($('touch'));
const sfx = new Sfx();
sfx.setMuted(load('ast.mute', '0') === '1');
$('btn-mute').textContent = sfx.muted ? '🔇' : '🔊';
document.addEventListener('pointerdown', () => sfx.unlock());
document.addEventListener('keydown', () => sfx.unlock());

type Mode =
  | { kind: 'menu' }
  | { kind: 'solo'; state: GameState }
  | { kind: 'host'; state: GameState; session: HostSession; names: string[]; pendingEvents: GameEvent[] }
  | { kind: 'guest'; session: GuestSession; names: string[]; snaps: View[]; offset: number | null; lastEventTick: number };

let mode: Mode = { kind: 'menu' };
let host: HostSession | null = null;
let guest: GuestSession | null = null;
let accumulator = 0;
let lastFrame = performance.now();
let lastView: View | null = null; // メニュー中の背景表示用
let lastNames: string[] = [];
let lastLocal = -1;

const TICK_MS = 1000 / TICK_RATE;
const SNAPSHOT_EVERY = 2; // 60Hz / 2 = 30Hz で配信
const INTERP_DELAY_TICKS = 6; // ゲストは約100ms遅れで補間表示

// ---------- 効果（音・パーティクル） ----------
function playEvents(events: GameEvent[], localId: number): void {
  renderer.addEffects(events);
  for (const e of events) {
    if (e.k === 'fire') sfx.fire(e.o === localId);
    else if (e.k === 'boom') sfx.boom(e.s);
    else if (e.k === 'hyper') sfx.blip(180, 0.2);
    else if (e.k === 'life' && e.o === localId) sfx.blip(1200, 0.3);
  }
}

function updateLoopSounds(view: View, localId: number): void {
  const me = view.ships.find((s) => s.id === localId);
  sfx.setThrust(!!me && me.alive && me.thr);
  sfx.setUfo(view.ufo ? (view.ufo.small ? 'small' : 'large') : 'none');
}

// ---------- メインループ ----------
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (mode.kind === 'solo' || mode.kind === 'host') {
    accumulator += dt;
    const frameEvents: GameEvent[] = [];
    const m = mode;
    let steps = 0;
    while (accumulator >= 1 / TICK_RATE && steps < 5) {
      accumulator -= 1 / TICK_RATE;
      steps++;
      if (m.kind === 'host') {
        // 切断したゲストの船を取り除く
        const connected = new Set([0, ...m.session.connected().map((g) => g.slot)]);
        for (const s of [...m.state.ships]) if (!connected.has(s.id)) removeShip(m.state, s.id);
        step(m.state, m.session.inputs(input.bits()));
        m.pendingEvents.push(...m.state.events);
        if (m.state.tick % SNAPSHOT_EVERY === 0 || m.state.over) {
          m.session.sendSnapshot(toView(m.state, m.pendingEvents));
          m.pendingEvents = [];
        }
      } else {
        step(m.state, [input.bits()]);
      }
      frameEvents.push(...m.state.events);
      if (m.state.over) break;
    }
    if (steps === 5) accumulator = 0;
    const view = toView(m.state, frameEvents);
    playEvents(frameEvents, 0);
    updateLoopSounds(view, 0);
    lastNames = m.kind === 'host' ? m.names : [playerName()];
    lastLocal = 0;
    renderer.draw(view, lastNames, 0, dt);
    lastView = view;
    if (m.state.over) finishLocalGame(m);
  } else if (mode.kind === 'guest') {
    const m = mode;
    m.session.sendInput(input.bits());
    const view = guestView(m, now);
    if (view) {
      updateLoopSounds(view, m.session.slot);
      renderer.draw(view, m.names, m.session.slot, dt);
      lastView = view;
      lastNames = m.names;
      lastLocal = m.session.slot;
    } else {
      renderer.draw(emptyView(), m.names, m.session.slot, dt);
    }
  } else {
    renderer.draw(lastView ?? emptyView(), lastNames, lastLocal, dt);
  }
  requestAnimationFrame(frame);
}

function emptyView(): View {
  return { mode: 'solo', tick: 0, timeLeft: 0, wave: 0, over: false, ships: [], bullets: [], rocks: [], ufo: null, events: [] };
}

function guestView(m: Extract<Mode, { kind: 'guest' }>, now: number): View | null {
  const snaps = m.snaps;
  if (snaps.length === 0 || m.offset === null) return null;
  const rt = (now - m.offset) / TICK_MS - INTERP_DELAY_TICKS;
  if (rt <= snaps[0].tick) return snaps[0];
  for (let i = snaps.length - 1; i >= 0; i--) {
    const a = snaps[i];
    if (a.tick <= rt) {
      const b = snaps[i + 1];
      if (!b) return a; // 最新より先は予測せず最新を表示
      return interpolateView(a, b, (rt - a.tick) / (b.tick - a.tick));
    }
  }
  return snaps[snaps.length - 1];
}

function onGuestSnapshot(v: View): void {
  if (mode.kind !== 'guest') return;
  const m = mode;
  const now = performance.now();
  // 受信時刻とティックの対応を推定（最も早く届いたものを基準に、ゆっくり追従）
  const o = now - v.tick * TICK_MS;
  if (m.offset === null || o < m.offset) m.offset = o;
  else m.offset += (o - m.offset) * 0.02;

  if (v.tick > m.lastEventTick) {
    m.lastEventTick = v.tick;
    playEvents(v.events, m.session.slot);
  }
  // ティック順に挿入（順序保証なしのチャネルのため）
  let i = m.snaps.length;
  while (i > 0 && m.snaps[i - 1].tick > v.tick) i--;
  if (i > 0 && m.snaps[i - 1].tick === v.tick) return;
  m.snaps.splice(i, 0, v);
  if (m.snaps.length > 40) m.snaps.splice(0, m.snaps.length - 40);
}

// ---------- ソロ ----------
function startSolo(): void {
  sfx.unlock();
  mode = { kind: 'solo', state: createGame({ mode: 'solo', players: [0] }) };
  accumulator = 0;
  show(null);
}

function finishLocalGame(m: Extract<Mode, { kind: 'solo' | 'host' }>): void {
  sfx.silence();
  const scores = m.state.ships.map((s) => ({ slot: s.id, score: s.score }));
  if (m.kind === 'solo') {
    const score = scores[0]?.score ?? 0;
    const best = Math.max(score, Number(load('ast.best', '0')) || 0);
    save('ast.best', String(best));
    mode = { kind: 'menu' };
    showResult('GAME OVER', [{ slot: 0, score }], [playerName()], `ハイスコア: ${best}`, [
      { label: 'もう一度', primary: true, onClick: startSolo },
      { label: 'タイトルへ', onClick: toTitle },
    ]);
  } else {
    m.session.endGame(scores);
    const session = m.session;
    const names = m.names;
    mode = { kind: 'menu' };
    showResult('TIME UP', scores, names, '', [
      {
        label: 'ロビーへ戻る',
        primary: true,
        onClick: () => {
          session.returnToLobby();
          showHostLobby();
        },
      },
    ]);
  }
}

function quitGame(): void {
  if (mode.kind === 'solo') {
    sfx.silence();
    mode = { kind: 'menu' };
    toTitle();
  } else if (mode.kind === 'host') {
    if (!confirm('ゲームを終了しますか？（全員の結果が確定します）')) return;
    mode.state.over = true;
  } else if (mode.kind === 'guest') {
    if (!confirm('退出しますか？')) return;
    leaveGuest();
  }
}

// ---------- 結果 ----------
interface ResultButton {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

function showResult(title: string, scores: { slot: number; score: number }[], names: string[], msg: string, buttons: ResultButton[]): void {
  $('result-title').textContent = title;
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top = sorted[0]?.score ?? 0;
  $('result-list').innerHTML = sorted
    .map(
      (s) =>
        `<li style="color:${PLAYER_COLORS[s.slot % PLAYER_COLORS.length]}"><span>${scores.length > 1 && s.score === top ? '👑 ' : ''}${esc(names[s.slot] ?? `P${s.slot + 1}`)}</span><span>${s.score}</span></li>`,
    )
    .join('');
  $('result-msg').textContent = msg;
  const box = $('result-buttons');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.primary) el.className = 'primary';
    el.onclick = b.onClick;
    box.appendChild(el);
  }
  show('screen-result');
}

// ---------- タイトル ----------
function toTitle(msg = ''): void {
  sfx.silence();
  host?.closeAll();
  host = null;
  guest?.close();
  guest = null;
  mode = { kind: 'menu' };
  $('title-msg').textContent = msg;
  lastView = null;
  show('screen-title');
}

function checkWebRtc(): boolean {
  if (typeof RTCPeerConnection === 'undefined') {
    $('title-msg').textContent = 'このブラウザはWebRTCに対応していないため、対戦できません。';
    return false;
  }
  return true;
}

// ---------- ホスト ----------
const slotRenderKey = new Map<number, string>();

function showHostLobby(): void {
  if (!host) return;
  $('host-self-name').textContent = host.hostName;
  slotRenderKey.clear();
  renderHostSlots();
  show('screen-host');
}

function renderHostSlots(): void {
  if (!host) return;
  const box = $('host-slots');
  for (const g of host.guests) {
    let el = box.querySelector<HTMLElement>(`[data-slot="${g.slot}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'slot';
      el.dataset.slot = String(g.slot);
      box.appendChild(el);
    }
    // 入力中のテキストを消さないよう、状態が変わったときだけ作り直す
    const key = `${g.status}|${g.error}|${g.name}|${g.offerCode.length}`;
    if (slotRenderKey.get(g.slot) !== key) {
      slotRenderKey.set(g.slot, key);
      const prevAnswer = el.querySelector<HTMLTextAreaElement>('.answer')?.value ?? '';
      el.innerHTML = slotHtml(g);
      const answer = el.querySelector<HTMLTextAreaElement>('.answer');
      if (answer) answer.value = prevAnswer;
      bindSlot(el, g);
    }
    // 診断表示は作り直さずに更新（入力中のテキストやフォーカスを保つ）
    const diag = el.querySelector<HTMLElement>('.diag');
    if (diag) diag.textContent = g.diag;
  }
  const n = host.connected().length;
  const start = $<HTMLButtonElement>('btn-start');
  start.disabled = false;
  start.textContent = n === 0 ? 'ゲーム開始（1人で練習）' : `ゲーム開始（${n + 1}人）`;
}

function reportHtml(report: string): string {
  if (!report) return '';
  return `<details class="report"><summary>詳しい診断情報</summary><pre>${esc(report)}</pre>
    <div class="buttons inline"><button class="act-copy-report">診断情報をコピー</button></div></details>`;
}

function bindReport(el: HTMLElement, report: string): void {
  el.querySelector('.act-copy-report')?.addEventListener('click', (e) => void copyString(report, e.currentTarget as HTMLButtonElement));
}

function slotHtml(g: GuestSlot): string {
  const color = PLAYER_COLORS[g.slot];
  const head = (status: string) =>
    `<div class="head"><span class="dot" style="--c:${color}"></span>P${g.slot + 1} <span class="status">${status}</span></div>`;
  const err = g.error ? `<p class="error">${esc(g.error)}</p>` : '';
  switch (g.status) {
    case 'empty':
      return `${head('空き')}${err}${g.error ? '<p class="diag"></p>' : ''}${reportHtml(g.report)}<div class="buttons inline"><button class="act-invite">招待コードを作成</button></div>`;
    case 'inviting':
      return `${head('招待コードを作成中…（数秒かかります）')}`;
    case 'waitingAnswer':
      return `${head('返答待ち')}
        <div class="label">① ゲストのスマホのカメラでこのQRコードを読み取ってもらう</div>
        <div class="qr">${qrSvg(joinUrl(g.offerCode))}</div>
        <div class="label">QRを使えないときは、この招待コード（または参加URL）を送る</div>
        <textarea readonly class="offer">${esc(g.offerCode)}</textarea>
        <div class="buttons inline"><button class="act-copy">コードをコピー</button><button class="act-copy-url">参加URLをコピー</button>${canShare ? '<button class="act-share">共有</button>' : ''}</div>
        <div class="label">② ゲストの画面に出た返答コードを読み取る／貼り付ける</div>
        ${canScan() ? '<div class="buttons inline"><button class="act-scan primary">返答QRを読み取る</button></div>' : ''}
        <textarea class="answer" placeholder="AST1A. から始まるコード"></textarea>
        ${err}
        <p class="diag"></p>
        <div class="buttons inline"><button class="act-accept primary">接続</button><button class="act-cancel">キャンセル</button></div>`;
    case 'connecting':
      return `${head('接続中…（最大30秒ほどかかります）')}${err}<p class="diag"></p><div class="buttons inline"><button class="act-cancel">キャンセル</button></div>`;
    case 'connected':
      return `${head(`✔ ${esc(g.name || '（名前待ち）')} 接続済み`)}<div class="buttons inline"><button class="act-cancel">切断</button></div>`;
  }
}

function bindSlot(el: HTMLElement, g: GuestSlot): void {
  const on = (cls: string, fn: () => void) => el.querySelector(`.${cls}`)?.addEventListener('click', fn);
  bindReport(el, g.report);
  on('act-invite', () => void host?.createInvite(g.slot));
  on('act-cancel', () => host?.cancel(g.slot));
  on('act-copy', () => copyText(el.querySelector<HTMLTextAreaElement>('.offer')!, el.querySelector<HTMLButtonElement>('.act-copy')!));
  on('act-copy-url', () => copyString(joinUrl(g.offerCode), el.querySelector<HTMLButtonElement>('.act-copy-url')!));
  on('act-share', () => void navigator.share?.({ url: joinUrl(g.offerCode) }).catch(() => {}));
  on('act-scan', async () => {
    const text = await scanQr($('scanner'));
    if (!text) return;
    const area = el.querySelector<HTMLTextAreaElement>('.answer');
    if (area) area.value = text;
    void host?.acceptAnswer(g.slot, text);
  });
  on('act-accept', () => {
    const code = el.querySelector<HTMLTextAreaElement>('.answer')!.value;
    if (code.trim()) void host?.acceptAnswer(g.slot, code);
  });
}

async function copyText(area: HTMLTextAreaElement, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(area.value);
  } catch {
    area.select();
    document.execCommand('copy');
  }
  flash(btn);
}

async function copyString(text: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn);
  } catch {
    btn.textContent = 'コピーできませんでした';
  }
}

function flash(btn: HTMLButtonElement): void {
  const old = btn.textContent;
  btn.textContent = 'コピーしました';
  setTimeout(() => (btn.textContent = old), 1500);
}

function openHost(): void {
  if (!checkWebRtc()) return;
  save('ast.name', playerName());
  host = new HostSession(playerName(), stunInput.checked);
  host.durationSec = Number($<HTMLSelectElement>('duration').value);
  host.onChange = () => {
    if (!$('screen-host').classList.contains('hidden')) renderHostSlots();
  };
  $('host-slots').innerHTML = '';
  showHostLobby();
}

function startHostGame(): void {
  if (!host) return;
  sfx.unlock();
  host.durationSec = Number($<HTMLSelectElement>('duration').value);
  const players = host.startGame();
  const names: string[] = [];
  for (const p of players) names[p.slot] = p.name;
  mode = {
    kind: 'host',
    session: host,
    names,
    pendingEvents: [],
    state: createGame({ mode: 'versus', players: players.map((p) => p.slot), durationSec: host.durationSec }),
  };
  accumulator = 0;
  show(null);
}

// ---------- ゲスト ----------
function openGuest(): GuestSession | null {
  if (!checkWebRtc()) return null;
  save('ast.name', playerName());
  guest = new GuestSession(playerName(), stunInput.checked);
  const g = guest;
  g.onChange = () => {
    if (guest === g && mode.kind !== 'guest' && !$('screen-guest').classList.contains('hidden')) renderGuest();
  };
  g.onStart = (players) => startGuestGame(g, players);
  g.onSnapshot = onGuestSnapshot;
  g.onEnd = (scores) => {
    if (mode.kind !== 'guest') return;
    const names = mode.names;
    sfx.silence();
    mode = { kind: 'menu' };
    showResult('TIME UP', scores, names, 'ホストが次のゲームを始めるのを待っています…', [{ label: '退出する', onClick: leaveGuest }]);
  };
  g.onClosed = () => {
    if (guest !== g) return;
    // 一度も接続できなかったときは、原因を表示したまま参加画面に留まる
    if (g.players.length === 0) {
      if (mode.kind !== 'guest') renderGuest();
      return;
    }
    toTitle('ホストとの接続が切れました。');
  };
  $<HTMLInputElement>('guest-name').value = playerName();
  renderGuest();
  show('screen-guest');
  return g;
}

function leaveGuest(): void {
  toTitle();
}

function renderGuest(): void {
  const g = guest;
  if (!g) return;
  const body = $('guest-body');
  const err = g.error ? `<p class="error">${esc(g.error)}</p>` : '';
  const diag = g.diag ? `<p class="diag">${esc(g.diag)}</p>` : '';
  switch (g.phase) {
    case 'idle':
    case 'closed':
      body.innerHTML = `<p class="sub">ホストの画面のQRコードをスマホのカメラで読み取ると、この画面が自動で進みます。</p>
        <div class="label sub">① ホストから届いた招待コードを貼り付ける</div>
        <textarea class="invite" placeholder="AST1O. から始まるコード"></textarea>${err}${g.error ? diag : ''}${reportHtml(g.report)}
        <div class="buttons inline"><button class="act-answer primary">返答コードを作成</button></div>`;
      bindReport(body, g.report);
      body.querySelector('.act-answer')!.addEventListener('click', () => {
        const code = body.querySelector<HTMLTextAreaElement>('.invite')!.value;
        if (code.trim()) void g.createAnswer(code);
      });
      break;
    case 'answering':
      body.innerHTML = `<p class="sub">返答コードを作成中…（数秒かかります）</p>`;
      break;
    case 'waitingConnect':
      body.innerHTML = `<div class="label sub">② ホストにこのQRコードを読み取ってもらう</div>
        <div class="qr">${qrSvg(g.answerCode)}</div>
        <div class="label sub">読み取れないときは、この返答コードをホストに送る</div>
        <textarea readonly class="answer">${esc(g.answerCode)}</textarea>
        <div class="buttons inline"><button class="act-copy">コピー</button>${canShare ? '<button class="act-share">共有</button>' : ''}</div>
        <p class="sub">ホストがQRを読み取るか返答コードを貼り付けると接続されます。接続を待っています…（最大30秒ほど）</p>${diag}`;
      body.querySelector('.act-copy')!.addEventListener('click', (e) =>
        copyText(body.querySelector<HTMLTextAreaElement>('.answer')!, e.currentTarget as HTMLButtonElement),
      );
      body.querySelector('.act-share')?.addEventListener('click', () => void navigator.share?.({ text: g.answerCode }).catch(() => {}));
      break;
    case 'lobby':
    case 'playing': {
      const list = g.players
        .map((p) => `<div class="host-self"><span class="dot" style="--c:${PLAYER_COLORS[p.slot]}"></span>${esc(p.name)}${p.slot === g.slot ? '（あなた）' : ''}${p.slot === 0 ? '（ホスト）' : ''}</div>`)
        .join('');
      body.innerHTML = `<p>✔ 接続しました。ホストがゲームを開始するのを待っています。</p>
        <p class="sub">制限時間: ${Math.round(g.durationSec / 60)}分</p>${list}`;
      break;
    }
  }
}

function startGuestGame(g: GuestSession, players: LobbyPlayer[]): void {
  sfx.unlock();
  const names: string[] = [];
  for (const p of players) names[p.slot] = p.name;
  mode = { kind: 'guest', session: g, names, snaps: [], offset: null, lastEventTick: -1 };
  show(null);
}

// ---------- ボタン ----------
$('btn-solo').addEventListener('click', startSolo);
$('btn-host').addEventListener('click', openHost);
$('btn-join').addEventListener('click', () => openGuest());
$('guest-name').addEventListener('input', () => {
  const v = $<HTMLInputElement>('guest-name').value.trim().slice(0, 12);
  nameInput.value = v;
  save('ast.name', v);
  if (guest) guest.name = v || 'Player';
});
$('btn-start').addEventListener('click', startHostGame);
$('btn-host-back').addEventListener('click', () => toTitle());
$('btn-guest-back').addEventListener('click', () => toTitle());
$('btn-quit').addEventListener('click', quitGame);
$('btn-mute').addEventListener('click', () => {
  sfx.setMuted(!sfx.muted);
  save('ast.mute', sfx.muted ? '1' : '0');
  $('btn-mute').textContent = sfx.muted ? '🔇' : '🔊';
});
$('duration').addEventListener('change', () => {
  if (host) {
    host.durationSec = Number($<HTMLSelectElement>('duration').value);
    host.broadcastLobby();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (mode.kind === 'host' || mode.kind === 'guest' || (host?.connected().length ?? 0) > 0 || guest?.phase === 'lobby') {
    e.preventDefault();
  }
});

// QR コード（参加URL）から開かれたときは、そのまま参加手続きを始める
function joinFromUrl(): boolean {
  const code = takeJoinCodeFromUrl();
  if (!code || typeof RTCPeerConnection === 'undefined') return false;
  if (mode.kind !== 'menu') return true; // ゲーム中は無視
  host?.closeAll();
  host = null;
  guest?.close();
  void openGuest()?.createAnswer(code);
  return true;
}
// ページを開いたまま参加URLを開き直した場合
window.addEventListener('hashchange', () => joinFromUrl());
if (!joinFromUrl()) show('screen-title');
requestAnimationFrame(frame);
