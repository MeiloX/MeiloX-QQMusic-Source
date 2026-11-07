// SPDX-License-Identifier: GPL-3.0-only
// Explicit anonymous public-catalog integration checks. Never accepts credentials or performs writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { decodeHostResponse } from '../src/transport.js';
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const probes = [
  ['catalog.track', { trackId: '0039MnYb0qxYhV' }],
  ['feed.home', { offset: 0, limit: 3 }],
  ['feed.discover', { offset: 0, limit: 3 }],
  ['album.get', { albumId: '000LFWfZ3G7QtG' }],
  ['album.tracks', { albumId: '000LFWfZ3G7QtG', offset: 0, limit: 3 }],
  ['artist.get', { artistId: '0025NhlN2yWrP4' }],
  ['artist.tracks', { artistId: '0025NhlN2yWrP4', offset: 0, limit: 3 }],
  ['artist.albums', { artistId: '0025NhlN2yWrP4', offset: 0, limit: 3 }],
  ['playlist.get', { playlistId: '8044204090' }],
  ['playlist.tracks', { playlistId: '8044204090', offset: 0, limit: 3 }],
];
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value :
  typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const context = () => ({ apiVersion: 2, config: {}, storage: {}, secureRandomBase64: randomBytes(256).toString('base64') });
for (const [operation, params] of (process.argv.includes('--feeds') ? probes.filter(([operation]) => operation.startsWith('feed.')) : probes)) {
  const isolated = vm.createContext({});
  vm.runInContext(source, isolated, { timeout: 1000 });
  isolated.params = params; isolated.op = operation; isolated.context = context();
  let value = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin[op](params, context))', isolated, { timeout: 1000 }));
  for (let hop = 0; value?.request; hop++) {
    assert.ok(hop < 4, 'Public catalog request limit exceeded');
    const request = value.request;
    assert.ok(new URL(request.url).hostname === 'u.y.qq.com' && !request.headers.Cookie, 'Only anonymous QQ catalog requests are allowed');
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body,
      redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length <= 1024 * 1024, 'Public catalog response exceeded the host limit');
    const host = { status: response.status, body: '', bodyBase64: Buffer.from(bytes).toString('base64') };
    const decoded = decodeHostResponse(host);
    let payload;
    try { payload = JSON.parse(decoded.body); } catch (_) { payload = null; }
    const nodes = Object.entries(payload || {}).filter(([key, node]) => key !== 'code' && node && typeof node === 'object' && !Array.isArray(node));
    console.log(JSON.stringify({ operation, httpStatus: response.status, topCode: integer(payload?.code),
      decoderValid: Boolean(decoded.body), nodes: nodes.map(([, node]) => ({ childCode: integer(node.code), dataCode: integer(node.data?.code),
        track: Boolean(node.data?.track_info), album: Boolean(node.data?.basicInfo), artist: Array.isArray(node.data?.singer_list),
        playlists: Array.isArray(node.data?.List), songs: Array.isArray(node.data?.songlist) || Array.isArray(node.data?.songList),
        albums: Array.isArray(node.data?.albums) || Array.isArray(node.data?.albumList), charts: Array.isArray(node.data?.group), categories: Array.isArray(node.data?.category) })) }));
    assert.ok(response.status === 200 && payload && integer(payload.code) === 0, 'Public QQ catalog request was not accepted');
    isolated.response = host; isolated.state = value.state; isolated.context = context();
    value = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin.onResponse(op, response, state, context))', isolated, { timeout: 1000 }));
  }
  assert.ok(value && !value.error && value.result !== undefined, 'Public QQ catalog callback rejected its response');
  if (operation.startsWith('feed.')) assert.ok(value.result.sections?.some(section => section.items?.length > 0), 'Public QQ feed has no projected content');
}
console.log('Anonymous public catalog checks passed; no account or playback URL was requested.');
