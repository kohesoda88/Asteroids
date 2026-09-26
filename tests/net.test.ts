import { describe, expect, it } from 'vitest';
import { createGame, step } from '../src/core/sim';
import { interpolateView, toView } from '../src/core/view';
import { decodeView, encodeView } from '../src/net/protocol';
import { ANSWER_PREFIX, CodeError, OFFER_PREFIX, decodeSdp, encodeSdp } from '../src/net/signaling';
import { IN_FIRE, IN_THRUST, WORLD_W } from '../src/core/constants';

const SAMPLE_SDP = `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host generation 0\r\na=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdefghijklmn\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n`;

describe('signaling', () => {
  it('SDP を圧縮コードにして元に戻せる', async () => {
    const code = await encodeSdp(OFFER_PREFIX, SAMPLE_SDP);
    expect(code.startsWith(OFFER_PREFIX)).toBe(true);
    expect(code).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(await decodeSdp(OFFER_PREFIX, code)).toBe(SAMPLE_SDP);
  });

  it('貼り付け時の改行や空白を無視する', async () => {
    const code = await encodeSdp(ANSWER_PREFIX, SAMPLE_SDP);
    const messy = `  ${code.slice(0, 20)}\n${code.slice(20)} \n`;
    expect(await decodeSdp(ANSWER_PREFIX, messy)).toBe(SAMPLE_SDP);
  });

  it('招待コードと返答コードの取り違えを検出する', async () => {
    const code = await encodeSdp(ANSWER_PREFIX, SAMPLE_SDP);
    await expect(decodeSdp(OFFER_PREFIX, code)).rejects.toThrow(CodeError);
    await expect(decodeSdp(OFFER_PREFIX, 'hello')).rejects.toThrow(CodeError);
  });

  it('途中で切れたコードはエラーになる', async () => {
    const code = await encodeSdp(OFFER_PREFIX, SAMPLE_SDP);
    await expect(decodeSdp(OFFER_PREFIX, code.slice(0, code.length - 30))).rejects.toThrow(CodeError);
  });
});

describe('snapshot protocol', () => {
  it('エンコード→JSON→デコードで状態がほぼ復元される', () => {
    const s = createGame({ mode: 'versus', players: [0, 1, 2], seed: 21, durationSec: 60 });
    for (let i = 0; i < 90; i++) step(s, [IN_FIRE | IN_THRUST, IN_FIRE, 0]);
    const v = toView(s);
    const back = decodeView(JSON.parse(JSON.stringify(encodeView(v))));
    expect(back.mode).toBe('versus');
    expect(back.tick).toBe(v.tick);
    expect(back.ships.map((x) => [x.id, x.score, x.alive])).toEqual(v.ships.map((x) => [x.id, x.score, x.alive]));
    expect(back.rocks).toHaveLength(v.rocks.length);
    back.rocks.forEach((r, i) => {
      expect(Math.abs(r.x - v.rocks[i].x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(r.a - v.rocks[i].a)).toBeLessThanOrEqual(0.01);
    });
    expect(Math.abs(back.timeLeft - v.timeLeft)).toBeLessThanOrEqual(0.05);
  });

  it('4人・小惑星多数でもスナップショットは十分小さい', () => {
    const s = createGame({ mode: 'versus', players: [0, 1, 2, 3], seed: 22 });
    for (let i = 0; i < 40; i++) step(s, [IN_FIRE, IN_FIRE, IN_FIRE, IN_FIRE]);
    // 大量の小惑星を追加して最悪に近いケースを作る
    for (let i = 0; i < 60; i++) s.rocks.push({ ...s.rocks[0], id: 5000 + i });
    const bytes = JSON.stringify({ t: 's', d: encodeView(toView(s)) }).length;
    expect(bytes).toBeLessThan(16 * 1024);
  });
});

describe('interpolateView', () => {
  it('画面端をまたぐ移動は短い方向に補間する', () => {
    const s = createGame({ mode: 'versus', players: [0], seed: 30 });
    const a = toView(s);
    const b = toView(s);
    a.rocks = [{ id: 1, s: 3, x: WORLD_W - 10, y: 100, a: 0 }];
    b.rocks = [{ id: 1, s: 3, x: 10, y: 100, a: 0 }];
    const mid = interpolateView(a, b, 0.5);
    expect(mid.rocks[0].x === 0 || mid.rocks[0].x === WORLD_W).toBe(true);
  });
});
