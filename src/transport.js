// SPDX-License-Identifier: GPL-3.0-only
// AG1/zzc protocol adapted from qmweb-sign (MIT); synchronous primitives use noble (MIT).
import { gcm } from '@noble/ciphers/aes.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { PUBLIC_AG1 } from './protocol-constants.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const entropyOffsets = new WeakMap();
const failure = code => ({ error: code });
export function utf8Bytes(text) {
  const result = [];
  for (let index = 0; index < text.length; index++) {
    let value = text.codePointAt(index);
    if (value > 0xffff) index++;
    else if (value >= 0xd800 && value <= 0xdfff) value = 0xfffd;
    if (value < 0x80) result.push(value);
    else if (value < 0x800) result.push(0xc0 | value >> 6, 0x80 | value & 63);
    else if (value < 0x10000) result.push(0xe0 | value >> 12, 0x80 | value >> 6 & 63, 0x80 | value & 63);
    else result.push(0xf0 | value >> 18, 0x80 | value >> 12 & 63, 0x80 | value >> 6 & 63, 0x80 | value & 63);
  }
  return new Uint8Array(result);
}
export function utf8Text(bytes) {
  // Decode strictly in bounded UTF-16 blocks; a per-byte percent-encoded rope can
  // exhaust the host's isolate heap before decodeURIComponent validates UTF-8.
  const block = new Uint16Array(4096), chunks = [];
  let used = 0;
  const flush = () => { chunks.push(String.fromCharCode.apply(null, block.subarray(0, used))); used = 0; };
  const continuation = index => {
    if (index >= bytes.length || (bytes[index] & 0xc0) !== 0x80) throw new URIError('Invalid UTF-8');
    return bytes[index] & 0x3f;
  };
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let point;
    if (first < 0x80) point = first;
    else if (first >= 0xc2 && first <= 0xdf) point = (first & 0x1f) << 6 | continuation(index++);
    else if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(index++), third = continuation(index++);
      if (first === 0xe0 && second < 0x20 || first === 0xed && second >= 0x20) throw new URIError('Invalid UTF-8');
      point = (first & 0x0f) << 12 | second << 6 | third;
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = continuation(index++), third = continuation(index++), fourth = continuation(index++);
      if (first === 0xf0 && second < 0x10 || first === 0xf4 && second >= 0x10) throw new URIError('Invalid UTF-8');
      point = (first & 7) << 18 | second << 12 | third << 6 | fourth;
    } else throw new URIError('Invalid UTF-8');
    if (used + (point > 0xffff ? 2 : 1) > block.length) flush();
    if (point > 0xffff) { point -= 0x10000; block[used++] = 0xd800 | point >> 10; block[used++] = 0xdc00 | point & 0x3ff; }
    else block[used++] = point;
  }
  if (used) flush();
  return chunks.join('');
}
export function base64(bytes) {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const word = bytes[index] << 16 | (bytes[index + 1] || 0) << 8 | (bytes[index + 2] || 0);
    result += alphabet[word >>> 18] + alphabet[word >>> 12 & 63] +
      (index + 1 < bytes.length ? alphabet[word >>> 6 & 63] : '=') + (index + 2 < bytes.length ? alphabet[word & 63] : '=');
  }
  return result;
}
export function unbase64(value) {
  if (typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid Base64');
  const end = value.indexOf('=');
  const length = end < 0 ? value.length : end;
  const bytes = new Uint8Array(Math.floor(length * 6 / 8));
  let bits = 0, count = 0, position = 0;
  for (let index = 0; index < length; index++) {
    bits = bits << 6 | alphabet.indexOf(value[index]); count += 6;
    if (count >= 8) { count -= 8; bytes[position++] = bits >>> count & 255; }
  }
  return bytes;
}
export function signBody(body) {
  const hash = sha1(utf8Bytes(body));
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  // Preserve the upstream JavaScript index-40 quirk: join() omits the undefined character.
  const first = PUBLIC_AG1.firstIndexes.map(index => hex[index]).join('');
  const last = PUBLIC_AG1.lastIndexes.map(index => hex[index]).join('');
  const mixed = hash.map((byte, index) => byte ^ PUBLIC_AG1.signMask[index]);
  return ('zzc' + first + base64(mixed).replace(/[+/=]/g, '') + last).toLowerCase();
}
export function encryptBody(body, iv) {
  if (!(iv instanceof Uint8Array) || iv.length !== 12) throw new Error('A fresh 12-byte nonce is required');
  const ciphertext = gcm(PUBLIC_AG1.aesKey, iv).encrypt(utf8Bytes(body));
  const frame = new Uint8Array(iv.length + ciphertext.length);
  frame.set(iv); frame.set(ciphertext, iv.length);
  return base64(frame);
}
function freshNonce(context) {
  if (!context || typeof context !== 'object') return null;
  let pool;
  try { pool = unbase64(context.secureRandomBase64); } catch (_) { return null; }
  const offset = entropyOffsets.get(context) || 0;
  if (pool.length !== 256 || offset + 12 > pool.length) return null;
  entropyOffsets.set(context, offset + 12);
  return pool.slice(offset, offset + 12);
}
export function encodeRequest(request, context) {
  if (request.url !== 'https://u.y.qq.com/cgi-bin/musicu.fcg') return failure('UNSUPPORTED');
  const iv = freshNonce(context);
  if (!iv) return failure('UNSUPPORTED');
  const body = String(request.body || '');
  return {
    ...request,
    url: 'https://u.y.qq.com/cgi-bin/musics.fcg?_=' + Date.now() + '&encoding=ag-1&sign=' + signBody(body),
    headers: { ...request.headers, 'Content-Type': 'text/plain', Accept: 'application/octet-stream', Origin: 'https://y.qq.com' },
    body: encryptBody(body, iv), responseEncoding: 'base64',
  };
}
function qqJSON(text) {
  try {
    const value = JSON.parse(text);
    const code = value && value.code;
    return value && typeof value === 'object' && !Array.isArray(value) &&
      (typeof code === 'number' && Number.isInteger(code) || typeof code === 'string' && /^-?\d+$/.test(code));
  } catch (_) { return false; }
}
export function decodeHostResponse(response) {
  // A plain QQ error may be returned before the encrypted transport is established.
  if (typeof response.body === 'string' && qqJSON(response.body)) return { body: response.body };
  if (typeof response.bodyBase64 !== 'string') return failure('INVALID_RESPONSE');
  try {
    const bytes = unbase64(response.bodyBase64);
    let plain;
    try { plain = utf8Text(bytes); } catch (_) { plain = ''; }
    if (qqJSON(plain)) return { body: plain };
    const clear = bytes.map((byte, index) => byte ^ PUBLIC_AG1.responseMask[index % PUBLIC_AG1.responseMask.length]);
    const body = utf8Text(clear);
    return qqJSON(body) ? { body } : failure('INVALID_RESPONSE');
  } catch (_) { return failure('INVALID_RESPONSE'); }
}
