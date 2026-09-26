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
    const sdp = await decodeSdp(OFFER_PREFIX, code);
    expect(sdp).toContain('a=ice-pwd:0123456789abcdefghijklmn\r\n');
    expect(sdp).toContain('192.168.1.10 54321 typ host');
  });

  it('貼り付け時の改行や空白を無視する', async () => {
    const code = await encodeSdp(ANSWER_PREFIX, SAMPLE_SDP);
    const messy = `  ${code.slice(0, 20)}\n${code.slice(20)} \n`;
    expect(await decodeSdp(ANSWER_PREFIX, messy)).toContain('a=ice-ufrag:abcd\r\n');
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

describe('summarizeCandidates', () => {
  it('SDP の ICE 候補を種類ごとに数える', async () => {
    const { summarizeCandidates } = await import('../src/net/peer');
    const sdp = `${SAMPLE_SDP}a=candidate:2 1 udp 1686052607 203.0.113.5 40000 typ srflx raddr 192.168.1.10 rport 54321\r\n`;
    expect(summarizeCandidates(sdp)).toEqual({ host: 1, srflx: 1, relay: 0 });
  });
});

describe('compact SDP', () => {
  const CHROME_OFFER = [
    'v=0',
    'o=- 4006630955374640212 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1467632932 1 udp 2113937151 73c2e780-5e4a-44e7-9f38-aa9a207922d1.local 35809 typ host generation 0 network-cost 999',
    'a=candidate:842163049 1 udp 1677729535 203.0.113.7 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
    'a=candidate:99 1 udp 2113939711 2001:db8::1:2 40000 typ host generation 0',
    'a=candidate:77 1 tcp 1518280447 192.168.1.2 9 typ host tcptype active generation 0',
    'a=ice-ufrag:mBkr',
    'a=ice-pwd:qwgEBu5aDiewsVDbLvNbnofb',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 00:14:68:86:38:D0:5B:96:90:2C:0A:1B:4F:D3:F3:71:F0:F7:0F:E7:C5:8E:A6:88:A6:4F:0C:31:EE:18:14:B7',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');

  it('必要な情報を保ったまま短いコードになる', async () => {
    const code = await encodeSdp(OFFER_PREFIX, CHROME_OFFER);
    expect(code[OFFER_PREFIX.length]).toBe('c');
    expect(code.length).toBeLessThan(200);
    const sdp = await decodeSdp(OFFER_PREFIX, code);
    expect(sdp).toContain('a=ice-ufrag:mBkr\r\n');
    expect(sdp).toContain('a=ice-pwd:qwgEBu5aDiewsVDbLvNbnofb\r\n');
    expect(sdp).toContain('a=fingerprint:sha-256 00:14:68:86:38:D0:5B:96:90:2C:0A:1B:4F:D3:F3:71:F0:F7:0F:E7:C5:8E:A6:88:A6:4F:0C:31:EE:18:14:B7\r\n');
    expect(sdp).toContain('a=setup:actpass\r\n');
    expect(sdp).toContain(' 2113937151 73c2e780-5e4a-44e7-9f38-aa9a207922d1.local 35809 typ host');
    expect(sdp).toContain(' 1677729535 203.0.113.7 61234 typ srflx raddr 0.0.0.0 rport 0');
    expect(sdp).toMatch(/ 2113939711 2001:db8:0:0:0:0:1:2 40000 typ host/);
    expect(sdp).not.toContain('tcp');
  });

  it('参加URLをそのまま貼り付けても読める', async () => {
    const code = await encodeSdp(OFFER_PREFIX, CHROME_OFFER);
    const sdp = await decodeSdp(OFFER_PREFIX, `https://example.github.io/Asteroids/#j=${code}`);
    expect(sdp).toContain('a=ice-ufrag:mBkr');
  });

  it('対応していない SDP は従来の圧縮形式になる', async () => {
    const odd = CHROME_OFFER.replace('sha-256', 'sha-384');
    const code = await encodeSdp(ANSWER_PREFIX, odd);
    expect(code[ANSWER_PREFIX.length]).toBe('z');
    expect(await decodeSdp(ANSWER_PREFIX, code)).toBe(odd);
  });
});
