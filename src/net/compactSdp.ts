// DataChannel 専用の SDP を、接続に必要な情報だけの小さなバイナリにする。
// QR コードに収まる長さにするため。想定外の SDP のときは null を返し、呼び出し側は通常の圧縮形式を使う。
//
// バイナリ形式（version 1）:
//   u8 version | u8 setup | str mid | str ufrag | str pwd | 32B sha-256 fingerprint
//   u8 候補数 | 候補ごとに: u8 (種類<<4 | アドレス形式) | アドレス | u16 port | u32 priority

const VERSION = 1;
const SETUPS = ['actpass', 'active', 'passive'];
const CAND_TYPES = ['host', 'srflx', 'prflx', 'relay'];
const ADDR_V4 = 0;
const ADDR_V6 = 1;
const ADDR_MDNS = 2; // <uuid>.local
const ADDR_STR = 3;
const MAX_CANDIDATES = 12;

class Writer {
  private buf: number[] = [];
  u8(v: number): void {
    this.buf.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number): void {
    this.u16(Math.floor(v / 0x10000));
    this.u16(v % 0x10000);
  }
  bytes(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new Error('too long');
    this.u8(b.length);
    this.bytes(b);
  }
  done(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

class Reader {
  private i = 0;
  constructor(private b: Uint8Array) {}
  u8(): number {
    if (this.i >= this.b.length) throw new Error('truncated');
    return this.b[this.i++];
  }
  u16(): number {
    return this.u8() * 256 + this.u8();
  }
  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error('truncated');
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  str(): string {
    return new TextDecoder().decode(this.bytes(this.u8()));
  }
  get atEnd(): boolean {
    return this.i === this.b.length;
  }
}

function hex(b: Uint8Array, sep = ''): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(sep);
}

function parseIpv6(s: string): Uint8Array | null {
  if (!/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

function formatIpv6(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return groups.join(':');
}

function writeAddr(w: Writer, typeIdx: number, addr: string): void {
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 && v4.slice(1).every((n) => Number(n) <= 255)) {
    w.u8((typeIdx << 4) | ADDR_V4);
    w.bytes(v4.slice(1).map(Number));
    return;
  }
  const mdns = addr.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/);
  if (mdns) {
    w.u8((typeIdx << 4) | ADDR_MDNS);
    const h = mdns.slice(1).join('');
    for (let i = 0; i < 32; i += 2) w.u8(parseInt(h.slice(i, i + 2), 16));
    return;
  }
  const v6 = parseIpv6(addr);
  if (v6) {
    w.u8((typeIdx << 4) | ADDR_V6);
    w.bytes(v6);
    return;
  }
  w.u8((typeIdx << 4) | ADDR_STR);
  w.str(addr);
}

function readAddr(r: Reader, kind: number): string {
  switch (kind) {
    case ADDR_V4:
      return Array.from(r.bytes(4)).join('.');
    case ADDR_V6:
      return formatIpv6(r.bytes(16));
    case ADDR_MDNS: {
      const h = hex(r.bytes(16));
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
    }
    case ADDR_STR:
      return r.str();
    default:
      throw new Error('bad address');
  }
}

/** SDP を小さなバイナリにする。対応できない SDP なら null */
export function compactSdp(sdp: string): Uint8Array | null {
  try {
    const lines = sdp.split(/\r?\n/);
    const get = (key: string) => lines.find((l) => l.startsWith(`a=${key}:`))?.slice(key.length + 3).trim();
    // DataChannel だけの SDP であること
    const media = lines.filter((l) => l.startsWith('m='));
    if (media.length !== 1 || !media[0].includes('webrtc-datachannel')) return null;
    const ufrag = get('ice-ufrag');
    const pwd = get('ice-pwd');
    const fp = get('fingerprint');
    const setup = SETUPS.indexOf(get('setup') ?? '');
    const mid = get('mid') ?? '0';
    const port = get('sctp-port') ?? '5000';
    if (!ufrag || !pwd || !fp || setup < 0 || port !== '5000') return null;
    const fpm = fp.match(/^sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/);
    if (!fpm) return null;

    const w = new Writer();
    w.u8(VERSION);
    w.u8(setup);
    w.str(mid);
    w.str(ufrag);
    w.str(pwd);
    w.bytes(fpm[1].split(':').map((x) => parseInt(x, 16)));

    // UDP の候補だけを使う（TCP 候補はこのゲームでは不要）
    const cands: { type: number; addr: string; port: number; prio: number }[] = [];
    for (const l of lines) {
      const m = l.match(/^a=candidate:\S+ 1 udp (\d+) (\S+) (\d+) typ (\w+)/i);
      if (!m) continue;
      const type = CAND_TYPES.indexOf(m[4]);
      if (type < 0) continue;
      cands.push({ prio: Number(m[1]), addr: m[2], port: Number(m[3]), type });
    }
    const use = cands.slice(0, MAX_CANDIDATES);
    w.u8(use.length);
    for (const c of use) {
      writeAddr(w, c.type, c.addr);
      w.u16(c.port);
      w.u32(c.prio);
    }
    return w.done();
  } catch {
    return null;
  }
}

/** compactSdp で作ったバイナリから、ブラウザが受け付ける SDP を組み立てる */
export function expandSdp(bytes: Uint8Array): string {
  const r = new Reader(bytes);
  if (r.u8() !== VERSION) throw new Error('unsupported version');
  const setup = SETUPS[r.u8()];
  if (!setup) throw new Error('bad setup');
  const mid = r.str();
  const ufrag = r.str();
  const pwd = r.str();
  const fp = hex(r.bytes(32), ':').toUpperCase();
  const n = r.u8();
  const cands: string[] = [];
  for (let i = 0; i < n; i++) {
    const head = r.u8();
    const type = CAND_TYPES[head >> 4];
    if (!type) throw new Error('bad candidate');
    const addr = readAddr(r, head & 0x0f);
    const port = r.u16();
    const prio = r.u32();
    const rel = type === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
    cands.push(`a=candidate:${i + 1} 1 udp ${prio} ${addr} ${port} typ ${type}${rel} generation 0`);
  }
  if (!r.atEnd) throw new Error('trailing data');
  const sessionId = String(Math.floor(Math.random() * 1e15));
  return [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...cands,
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}
