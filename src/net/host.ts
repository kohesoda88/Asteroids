import { MAX_PLAYERS } from '../core/constants';
import type { View } from '../core/view';
import { PeerLink, formatCandidates } from './peer';
import { encodeView, type LobbyPlayer, type ReliableMsg } from './protocol';

export type GuestStatus = 'empty' | 'inviting' | 'waitingAnswer' | 'connecting' | 'connected';

export interface GuestSlot {
  slot: number; // プレイヤースロット（1〜3、0はホスト）
  status: GuestStatus;
  link: PeerLink | null;
  name: string;
  input: number;
  offerCode: string;
  error: string;
  diag: string; // 接続診断の表示
  report: string; // 失敗時の詳しい診断（コピー用）
}

export function diagText(link: PeerLink): string {
  return `状態: ${link.stateText}／こちら: ${formatCandidates(link.localCandidates)}／相手: ${formatCandidates(link.remoteCandidates)}`;
}

/** ホスト：ゲストごとに1本の WebRTC 接続を持つスター型 */
export class HostSession {
  readonly guests: GuestSlot[] = [];
  durationSec = 180;
  inGame = false;
  onChange: () => void = () => {};

  constructor(
    public hostName: string,
    private useStun: boolean,
  ) {
    for (let slot = 1; slot < MAX_PLAYERS; slot++) {
      this.guests.push({ slot, status: 'empty', link: null, name: '', input: 0, offerCode: '', error: '', diag: '', report: '' });
    }
  }

  private reset(g: GuestSlot, error = '', diag = '', report = ''): void {
    const link = g.link;
    g.link = null; // 先に外してから閉じる（onClose で再度 reset されないように）
    link?.close();
    g.status = 'empty';
    g.name = '';
    g.input = 0;
    g.offerCode = '';
    g.error = error;
    g.diag = diag;
    g.report = report;
  }

  async createInvite(slot: number): Promise<void> {
    const g = this.guest(slot);
    this.reset(g);
    g.status = 'inviting';
    this.onChange();
    const link = new PeerLink(this.useStun);
    g.link = link;
    link.onReliable = (msg) => this.handleReliable(g, msg);
    link.onUnreliable = (msg) => {
      if (msg.t === 'in') g.input = msg.b | 0;
    };
    link.onClose = () => {
      if (g.link !== link) return;
      const wasConnected = g.status === 'connected';
      const diag = diagText(link);
      this.reset(g, wasConnected ? `${g.name || 'ゲスト'} との接続が切れました` : `接続できませんでした。${link.diagnosis()}`, diag, link.report());
      this.broadcastLobby();
      this.onChange();
    };
    link.onStateChange = () => {
      if (g.link !== link) return;
      g.diag = diagText(link);
      this.onChange();
    };
    link.opened.then(() => {
      if (g.link !== link) return;
      g.status = 'connected';
      g.error = '';
      link.sendReliable({ t: 'welcome', slot: g.slot });
      this.broadcastLobby();
      this.onChange();
    });
    try {
      g.offerCode = await link.createOfferCode();
      if (g.link === link) {
        g.status = 'waitingAnswer';
        g.diag = diagText(link);
      }
    } catch (e) {
      this.reset(g, `招待コードを作成できませんでした: ${(e as Error).message}`);
    }
    this.onChange();
  }

  async acceptAnswer(slot: number, code: string): Promise<void> {
    const g = this.guest(slot);
    if (!g.link) return;
    try {
      await g.link.acceptAnswerCode(code);
      g.status = 'connecting';
      g.diag = diagText(g.link);
      g.error = '';
    } catch (e) {
      g.error = (e as Error).message;
    }
    this.onChange();
  }

  cancel(slot: number): void {
    this.reset(this.guest(slot));
    this.broadcastLobby();
    this.onChange();
  }

  private guest(slot: number): GuestSlot {
    return this.guests.find((g) => g.slot === slot)!;
  }

  private handleReliable(g: GuestSlot, msg: ReliableMsg): void {
    if (msg.t === 'hello') {
      g.name = msg.name.slice(0, 12) || `P${g.slot + 1}`;
      this.broadcastLobby();
      this.onChange();
    }
  }

  connected(): GuestSlot[] {
    return this.guests.filter((g) => g.status === 'connected');
  }

  players(): LobbyPlayer[] {
    return [{ slot: 0, name: this.hostName }, ...this.connected().map((g) => ({ slot: g.slot, name: g.name || `P${g.slot + 1}` }))];
  }

  broadcastLobby(): void {
    const msg: ReliableMsg = { t: 'lobby', players: this.players(), durationSec: this.durationSec };
    for (const g of this.connected()) g.link!.sendReliable(msg);
  }

  startGame(): LobbyPlayer[] {
    this.inGame = true;
    const players = this.players();
    for (const g of this.connected()) {
      g.input = 0;
      g.link!.sendReliable({ t: 'start', players, durationSec: this.durationSec });
    }
    return players;
  }

  inputs(localInput: number): number[] {
    const arr = [localInput, 0, 0, 0];
    for (const g of this.connected()) arr[g.slot] = g.input;
    return arr;
  }

  sendSnapshot(view: View): void {
    const d = encodeView(view);
    for (const g of this.connected()) g.link!.sendUnreliable({ t: 's', d });
  }

  endGame(scores: { slot: number; score: number }[]): void {
    this.inGame = false;
    for (const g of this.connected()) g.link!.sendReliable({ t: 'end', scores });
  }

  returnToLobby(): void {
    this.inGame = false;
    this.broadcastLobby();
  }

  closeAll(): void {
    for (const g of this.guests) this.reset(g);
  }
}
