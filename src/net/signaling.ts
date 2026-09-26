// SDP（offer/answer）を手で受け渡しやすい短い文字列に変換する。
// 形式: "<接頭辞><形式1文字><Base64URL>"。接頭辞で招待コード/返答コードを区別する。

import { compactSdp, expandSdp } from './compactSdp';

export const OFFER_PREFIX = 'AST1O.';
export const ANSWER_PREFIX = 'AST1A.';
const RAW_MARK = 'r'; // 非圧縮
const DEFLATE_MARK = 'z'; // deflate-raw 圧縮
const COMPACT_MARK = 'c'; // 必要な情報だけのバイナリ（QR 向けに短い）

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const res = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

export async function encodeSdp(prefix: string, sdp: string): Promise<string> {
  const compact = compactSdp(sdp);
  if (compact) return prefix + COMPACT_MARK + toBase64Url(compact);
  const bytes = new TextEncoder().encode(sdp);
  if (hasCompression()) {
    try {
      const z = await pipe(bytes, new CompressionStream('deflate-raw'));
      return prefix + DEFLATE_MARK + toBase64Url(z);
    } catch {
      // 圧縮に失敗した場合は非圧縮で出力
    }
  }
  return prefix + RAW_MARK + toBase64Url(bytes);
}

export class CodeError extends Error {}

export async function decodeSdp(expectedPrefix: string, code: string): Promise<string> {
  let text = code.replace(/\s+/g, '');
  // 参加URLをそのまま貼り付けた場合はコード部分だけを使う
  const hashAt = text.indexOf('#j=');
  if (hashAt >= 0) text = decodeURIComponent(text.slice(hashAt + 3));
  if (!text.startsWith(expectedPrefix)) {
    const other = expectedPrefix === OFFER_PREFIX ? ANSWER_PREFIX : OFFER_PREFIX;
    if (text.startsWith(other)) {
      throw new CodeError(
        expectedPrefix === OFFER_PREFIX ? 'これは返答コードです。ホストの招待コードを貼り付けてください。' : 'これは招待コードです。ゲストの返答コードを貼り付けてください。',
      );
    }
    throw new CodeError('コードの形式が正しくありません。');
  }
  const mark = text[expectedPrefix.length];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text.slice(expectedPrefix.length + 1));
  } catch {
    throw new CodeError('コードが壊れています（途中で切れていないか確認してください）。');
  }
  if (mark === COMPACT_MARK) {
    try {
      return expandSdp(bytes);
    } catch {
      throw new CodeError('コードが壊れています（途中で切れていないか確認してください）。');
    }
  }
  if (mark === DEFLATE_MARK) {
    if (!hasCompression()) throw new CodeError('このブラウザは圧縮コードに対応していません。');
    try {
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } catch {
      throw new CodeError('コードが壊れています（途中で切れていないか確認してください）。');
    }
  } else if (mark !== RAW_MARK) {
    throw new CodeError('コードの形式が正しくありません。');
  }
  const sdp = new TextDecoder().decode(bytes);
  if (!sdp.startsWith('v=0')) throw new CodeError('コードの内容が正しくありません。');
  return sdp;
}
