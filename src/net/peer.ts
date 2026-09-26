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

  constructor(useStun: boolean) {
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
      this.onStateChange();
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.close();
    };
    this.pc.oniceconnectionstatechange = () => {
      this.onStateChange();
      // connectionState 非対応のブラウザ向け
      if (this.pc.iceConnectionState === 'failed') this.close();
    };
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
    this.remoteCandidates = summarizeCandidates(sdp);
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  // ---- ゲスト側 ----
  async createAnswerCode(offerCode: string): Promise<string> {
    const sdp = await decodeSdp(OFFER_PREFIX, offerCode);
    this.remoteCandidates = summarizeCandidates(sdp);
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitIceGathering(this.pc);
    this.localCandidates = summarizeCandidates(this.pc.localDescription!.sdp);
    return encodeSdp(ANSWER_PREFIX, this.pc.localDescription!.sdp);
  }
}
