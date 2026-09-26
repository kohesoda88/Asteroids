import type { ReliableMsg, UnreliableMsg } from './protocol';
import { ANSWER_PREFIX, OFFER_PREFIX, decodeSdp, encodeSdp } from './signaling';

// 公開STUNサーバー（自分のグローバルアドレスを知るためだけに使う。ゲームデータは中継しない）
const STUN_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const ICE_GATHER_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 8000;

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish();
    });
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) finish();
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
  private failing = false;

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
      this.onStateChange();
      // connectionState 非対応のブラウザ向け
      if (this.pc.iceConnectionState === 'failed') void this.fail();
    };
    this.pc.onicegatheringstatechange = () => this.note(`gathering=${this.pc.iceGatheringState}`);
    this.pc.addEventListener('icecandidateerror', (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      this.note(`候補エラー ${ev.errorCode} ${ev.url ?? ''}`);
    });
    this.rel.addEventListener('open', () => this.note('DataChannel open'));
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
    return map[this.pc.iceConnectionState] ?? this.pc.iceConnectionState;
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

  /** 失敗時：閉じる前に経路確認の統計を記録する */
  private async fail(): Promise<void> {
    if (this.failing || this.closed) return;
    this.failing = true;
    try {
      const stats = await this.pc.getStats();
      const pairs: Record<string, number> = {};
      const remote: string[] = [];
      stats.forEach((r) => {
        if (r.type === 'candidate-pair') pairs[r.state] = (pairs[r.state] ?? 0) + 1;
        if (r.type === 'remote-candidate') remote.push(`${r.candidateType}${r.address || r.ip ? '' : '(未解決)'}`);
      });
      this.statsText = `経路ペア: ${JSON.stringify(pairs)} / 相手候補: ${remote.join(', ') || 'なし'}`;
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
    await waitIceGathering(this.pc);
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
    await waitIceGathering(this.pc);
    this.localCandidates = summarizeCandidates(this.pc.localDescription!.sdp);
    return encodeSdp(ANSWER_PREFIX, this.pc.localDescription!.sdp);
  }
}
