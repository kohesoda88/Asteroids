import { decodeView, type LobbyPlayer } from './protocol';
import { PeerLink } from './peer';
import type { View } from '../core/view';

export type GuestPhase = 'idle' | 'answering' | 'waitingConnect' | 'lobby' | 'playing' | 'closed';

/** ゲスト：ホストとの接続1本 */
export class GuestSession {
  phase: GuestPhase = 'idle';
  slot = -1;
  players: LobbyPlayer[] = [];
  durationSec = 0;
  answerCode = '';
  error = '';
  private link: PeerLink | null = null;

  onChange: () => void = () => {};
  onStart: (players: LobbyPlayer[], durationSec: number) => void = () => {};
  onSnapshot: (view: View) => void = () => {};
  onEnd: (scores: { slot: number; score: number }[]) => void = () => {};
  onClosed: () => void = () => {};

  constructor(
    private name: string,
    private useStun: boolean,
  ) {}

  async createAnswer(offerCode: string): Promise<void> {
    this.link?.close();
    const link = new PeerLink(this.useStun);
    this.link = link;
    this.error = '';
    this.phase = 'answering';
    this.onChange();
    link.onReliable = (msg) => {
      switch (msg.t) {
        case 'welcome':
          this.slot = msg.slot;
          break;
        case 'lobby':
          this.players = msg.players;
          this.durationSec = msg.durationSec;
          if (this.phase !== 'playing') this.phase = 'lobby';
          this.onChange();
          break;
        case 'start':
          this.players = msg.players;
          this.durationSec = msg.durationSec;
          this.phase = 'playing';
          this.onStart(msg.players, msg.durationSec);
          break;
        case 'end':
          this.phase = 'lobby';
          this.onEnd(msg.scores);
          break;
      }
    };
    link.onUnreliable = (msg) => {
      if (msg.t === 's') this.onSnapshot(decodeView(msg.d));
    };
    link.onClose = () => {
      if (this.link !== link) return;
      this.phase = 'closed';
      this.onChange();
      this.onClosed();
    };
    link.opened.then(() => link.sendReliable({ t: 'hello', name: this.name }));
    try {
      this.answerCode = await link.createAnswerCode(offerCode);
      if (this.link === link && this.phase === 'answering') this.phase = 'waitingConnect';
    } catch (e) {
      this.link = null;
      link.close();
      this.phase = 'idle';
      this.error = (e as Error).message;
    }
    this.onChange();
  }

  sendInput(bits: number): void {
    this.link?.sendUnreliable({ t: 'in', b: bits });
  }

  close(): void {
    const link = this.link;
    this.link = null;
    link?.close();
    this.phase = 'closed';
  }
}
