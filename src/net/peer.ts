import type { ReliableMsg, UnreliableMsg } from './protocol';
import { ANSWER_PREFIX, OFFER_PREFIX, decodeSdp, encodeSdp } from './signaling';

// 公開STUNサーバー（自分のグローバルアドレスを知るためだけに使う。ゲームデータは中継しない）
const STUN_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const ICE_GATHER_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 8000;
// ゲストは返答コードを渡してからホストが読み込むまで時間がかかるため、その間は失敗扱いにしない
const ANSWER_WAIT_MS = 180000;

/**
 * ICE 候補の収集を待つ。「完了」にならないブラウザや回線があるため、
 * 必要な候補が揃って少し新しい候補が来なければ打ち切る。
 */
function waitIceGathering(pc: RTCPeerConnection, useStun: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const start = performance.now();
    let last = start;
    let any = false;
    let srflx = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve();
    };
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - start > ICE_GATHER_TIMEOUT_MS) return finish();
      // STUN 使用時はグローバルアドレス（srflx）が来るまで最大5秒待つ
      const enough = any && (!useStun || srflx || now - start > 5000);
      if (enough && now - last > 1000) finish();
    }, 200);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish();
    });
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return finish();
      any = true;
      last = performance.now();
      if (e.candidate.type === 'srflx' || / typ srflx /.test(e.candidate.candidate)) srflx = true;
    });
  });
}

export interface CandidateSummary {
  host: number; // 端末自身のアドレス（同じLAN内で使える）
  srflx: number; // STUNで分かったグローバルアドレス（インターネット越しに必要）
  relay: number;
}

/** SDP に含まれる ICE 候補の種類を数える（接続診断用） */
export function summarizeCandidates(sdp: string): CandidateSummary {
  const s: CandidateSummary = { host: 0, srflx: 0, relay: 0 };
  for (const m of sdp.matchAll(/^a=candidate:.* typ (host|srflx|prflx|relay)/gm)) {
    if (m[1] === 'host') s.host++;
    else if (m[1] === 'relay') s.relay++;
    else s.srflx++;
  }
  return s;
}

export function formatCandidates(s: CandidateSummary | null): string {
  if (!s) return '—';
  return `LAN ${s.host} / グローバル ${s.srflx}`;
}

/** アドレスの種類だけを返す（IPアドレスそのものは出さない） */
function addrKind(addr: string): string {
  if (addr.endsWith('.local')) return 'mDNS';
  if (addr.includes(':')) return addr.toLowerCase().startsWith('fe80') ? 'IPv6(リンクローカル)' : 'IPv6';
  const p = addr.split('.').map(Number);
  if (p.length !== 4) return '不明';
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'IPv4(プライベート)';
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'IPv4(CGNAT)';
  if (p[0] === 169 && p[1] === 254) return 'IPv4(リンクローカル)';
  return 'IPv4(グローバル)';
}

/** SDP の候補を「種類/プロトコル/アドレスの種類」の一覧にする（診断用） */
export function describeCandidates(sdp: string): string {
  const out: string[] = [];
  for (const m of sdp.matchAll(/^a=candidate:\S+ \d+ (\w+) \d+ (\S+) \d+ typ (\w+)/gm)) out.push(`${m[3]}/${m[1]}/${addrKind(m[2])}`);
  return out.length ? out.join(', ') : '(候補なし)';
}

/** WebRTC 接続1本分。信頼性あり/なしの2つの DataChannel を持つ */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private rel: RTCDataChannel;
  private unrel: RTCDataChannel;
  private lastRecv = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private openResolve!: () => void;
  readonly opened: Promise<void>;

  onReliable: (msg: ReliableMsg) => void = () => {};
  onUnreliable: (msg: UnreliableMsg) => void = () => {};
  onClose: () => void = () => {};
  onStateChange: () => void = () => {};
  localCandidates: CandidateSummary | null = null;
  remoteCandidates: CandidateSummary | null = null;
  private readonly t0 = performance.now();
  private log: string[] = [];
  private remoteSdp = '';
  private statsText = '';
  private lastStats = '';
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private failing = false;
  private everOpened = false;
  private waitingForHost = false; // ゲスト：ホストが返答を読み込むのを待っている
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  private note(s: string): void {
    this.log.push(`+${((performance.now() - this.t0) / 1000).toFixed(1)}s ${s}`);
  }

  constructor(private useStun: boolean) {
    this.pc = new RTCPeerConnection({ iceServers: useStun ? STUN_SERVERS : [] });
    // negotiated: true で両側が同じ id のチャネルを作る（ondatachannel 不要）
    this.rel = this.pc.createDataChannel('rel', { negotiated: true, id: 0, ordered: true });
    this.unrel = this.pc.createDataChannel('unrel', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    this.opened = new Promise((res) => (this.openResolve = res));

    this.rel.onopen = () => {
      this.lastRecv = performance.now();
      this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
      this.openResolve();
    };
    this.rel.onclose = () => this.close();
    this.rel.onmessage = (e) => {
      this.lastRecv = performance.now();
      const msg = JSON.parse(e.data as string) as ReliableMsg;
      if (msg.t !== 'ping') this.onReliable(msg);
    };
    this.unrel.onmessage = (e) => {
      this.lastRecv = performance.now();
      this.onUnreliable(JSON.parse(e.data as string) as UnreliableMsg);
    };
    this.pc.onconnectionstatechange = () => {
      this.note(`connection=${this.pc.connectionState}`);
      this.onStateChange();
      if (this.pc.connectionState === 'failed') void this.fail();
      else if (this.pc.connectionState === 'closed') this.close();
    };
    this.pc.oniceconnectionstatechange = () => {
      this.note(`ice=${this.pc.iceConnectionState}`);
      // 経路確認中は途中経過を定期的に記録する（失敗後は統計が消えることがあるため）
      if (this.pc.iceConnectionState === 'checking' && !this.statsTimer) {
        this.statsTimer = setInterval(() => void this.snapshotStats(), 2000);
      } else if (this.pc.iceConnectionState !== 'checking' && this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
      this.onStateChange();
      // connectionState 非対応のブラウザ向け
      if (this.pc.iceConnectionState === 'failed') void this.fail();
    };
    this.pc.onicegatheringstatechange = () => this.note(`gathering=${this.pc.iceGatheringState}`);
    this.pc.addEventListener('icecandidateerror', (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      this.note(`候補エラー ${ev.errorCode} ${ev.url ?? ''}`);
    });
    this.rel.addEventListener('open', () => {
      this.note('DataChannel open');
      this.everOpened = true;
      this.waitingForHost = false;
      if (this.waitTimer) clearTimeout(this.waitTimer);
    });
  }

  /** 接続状態を表示用の文字列にする */
  get stateText(): string {
    const map: Record<string, string> = {
      new: '準備中',
      checking: '経路を確認中',
      connected: '接続',
      completed: '接続',
      disconnected: '一時的に切断',
      failed: '失敗',
      closed: '終了',
    };
    const st = this.pc.iceConnectionState;
    if (this.waitingForHost && !this.everOpened && (st === 'failed' || st === 'disconnected' || st === 'checking')) return 'ホストの読み取り待ち';
    return map[st] ?? st;
  }

  /** 接続できなかったときの原因の見立て */
  diagnosis(): string {
    const l = this.localCandidates;
    const r = this.remoteCandidates;
    if (!l || !r) return '';
    if (l.srflx === 0 || r.srflx === 0) {
      const who = l.srflx === 0 && r.srflx === 0 ? '両方' : l.srflx === 0 ? 'こちら側' : '相手側';
      return `${who}でグローバルアドレスが取れていません。STUNをONにして作り直すか、同じWi-Fiにつないで試してください。`;
    }
    return '両方ともグローバルアドレスは取れていますが、直接つながりませんでした。回線（NAT）の組み合わせが原因の可能性があります。片方をスマホのテザリングや別のWi-Fiに変えて試してください。';
  }

  /** 経路確認の状況を要約する（送った確認・届いた確認・返ってきた応答の数など） */
  private async summarizeStats(): Promise<string> {
    const stats = await this.pc.getStats();
    const pairs: Record<string, number> = {};
    const remote: string[] = [];
    let sent = 0;
    let recv = 0;
    let resp = 0;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair') {
        pairs[r.state] = (pairs[r.state] ?? 0) + 1;
        sent += r.requestsSent ?? 0;
        recv += r.requestsReceived ?? 0;
        resp += r.responsesReceived ?? 0;
      }
      if (r.type === 'remote-candidate') remote.push(`${r.candidateType}/${r.protocol ?? ''}`);
    });
    return `経路ペア ${JSON.stringify(pairs)}／確認 送信${sent}・受信${recv}・応答受信${resp}／相手候補 ${remote.join(', ') || 'なし'}`;
  }

  private async snapshotStats(): Promise<void> {
    try {
      this.lastStats = await this.summarizeStats();
    } catch {
      // 閉じた後などは無視
    }
  }

  /** 失敗時：閉じる前に経路確認の統計を記録する */
  private async fail(force = false): Promise<void> {
    if (this.failing || this.closed) return;
    // ホストが返答を読み込む前にゲスト側の確認が失敗しても、ホストからの確認で立ち直れるので待つ
    if (!force && this.waitingForHost && !this.everOpened) {
      this.note('ホスト待ちのため継続');
      void this.snapshotStats();
      return;
    }
    this.failing = true;
    try {
      this.statsText = `失敗時: ${await this.summarizeStats()}`;
    } catch (e) {
      this.statsText = `統計取得失敗: ${(e as Error).message}`;
    }
    this.close();
  }

  /** 利用者がコピーして送れる診断レポート（IPアドレスは含めない） */
  report(): string {
    return [
      `ブラウザ: ${navigator.userAgent}`,
      `STUN: ${this.useStun ? 'ON' : 'OFF'}`,
      `こちらの候補: ${this.pc.localDescription ? describeCandidates(this.pc.localDescription.sdp) : '—'}`,
      `相手の候補: ${this.remoteSdp ? describeCandidates(this.remoteSdp) : '—'}`,
      `記録: ${this.log.join(' | ')}`,
      this.lastStats ? `確認中: ${this.lastStats}` : '',
      this.statsText,
    ]
      .filter(Boolean)
      .join('\n');
  }

  get isOpen(): boolean {
    return !this.closed && this.rel.readyState === 'open';
  }

  private heartbeat(): void {
    if (performance.now() - this.lastRecv > PEER_TIMEOUT_MS) {
      this.close();
      return;
    }
    this.sendReliable({ t: 'ping' });
  }

  sendReliable(msg: ReliableMsg): void {
    if (this.rel.readyState === 'open') this.rel.send(JSON.stringify(msg));
  }

  sendUnreliable(msg: UnreliableMsg): void {
    // 送信バッファが詰まっているときは古い状態を送っても無意味なので捨てる
    if (this.unrel.readyState === 'open' && this.unrel.bufferedAmount < 64 * 1024) this.unrel.send(JSON.stringify(msg));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    try {
      this.pc.close();
    } catch {
      // 既に閉じている
    }
    this.onClose();
  }

  // ---- ホスト側 ----
  async createOfferCode(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitIceGathering(this.pc, this.useStun);
    this.localCandidates = summarizeCandidates(this.pc.localDescription!.sdp);
    return encodeSdp(OFFER_PREFIX, this.pc.localDescription!.sdp);
  }

  async acceptAnswerCode(code: string): Promise<void> {
    const sdp = await decodeSdp(ANSWER_PREFIX, code);
    this.remoteSdp = sdp;
    this.note('返答コード受付');
    this.remoteCandidates = summarizeCandidates(sdp);
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  // ---- ゲスト側 ----
  async createAnswerCode(offerCode: string): Promise<string> {
    const sdp = await decodeSdp(OFFER_PREFIX, offerCode);
    this.remoteSdp = sdp;
    this.note('招待コード受付');
    this.remoteCandidates = summarizeCandidates(sdp);
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitIceGathering(this.pc, this.useStun);
    this.localCandidates = summarizeCandidates(this.pc.localDescription!.sdp);
    this.waitingForHost = true;
    this.waitTimer = setTimeout(() => {
      this.note('ホストからの接続を待ちきれず終了');
      void this.fail(true);
    }, ANSWER_WAIT_MS);
    return encodeSdp(ANSWER_PREFIX, this.pc.localDescription!.sdp);
  }
}
