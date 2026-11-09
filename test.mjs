import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomBytes, createDecipheriv, createHash } from 'node:crypto';
import { PUBLIC_AG1 } from './src/protocol-constants.js';
import { signBody, encryptBody, decodeHostResponse, encodeRequest, utf8Bytes, utf8Text, base64, unbase64 } from './src/transport.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const fixtures = Object.fromEntries(['search', 'detail', 'lyrics'].map(name => [name,
  JSON.parse(fs.readFileSync(path.join(root, `fixtures/captured-${name}.json`), 'utf8'))]));
const trackId = fixtures.detail.detail.data.track_info.mid;
const session = { cookie: 'uin=o123456; qqmusic_key=fixture%40key', uin: '' };

function requestPayload(request) {
  if (new URL(request.url).pathname === '/cgi-bin/musicu.fcg') return JSON.parse(request.body);
  assert.equal(new URL(request.url).pathname, '/cgi-bin/musics.fcg');
  assert.equal(new URL(request.url).searchParams.get('encoding'), 'ag-1');
  assert.equal(request.responseEncoding, 'base64');
  assert.equal(request.headers['Content-Type'], 'text/plain');
  const bytes = Buffer.from(request.body, 'base64');
  const decipher = createDecipheriv('aes-128-gcm', PUBLIC_AG1.aesKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const clear = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  assert.ok(new URL(request.url).searchParams.get('sign') === signBody(clear), 'QQ wire signature must match its body');
  return JSON.parse(clear);
}
function hostResponse(request, fixture) {
  const body = JSON.stringify(fixture);
  if (request.responseEncoding !== 'base64') return { status: 200, body };
  const bytes = Buffer.from(body, 'utf8');
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= PUBLIC_AG1.responseMask[index % PUBLIC_AG1.responseMask.length];
  return { status: 200, body: '', bodyBase64: bytes.toString('base64') };
}
function pluginContext(apiVersion, config, storage) {
  return { apiVersion, config, storage, secureRandomBase64: randomBytes(256).toString('base64') };
}

function create(config = {}, playback = null, apiVersion = 1, respond = null) {
  const isolated = vm.createContext({});
  vm.runInContext(source, isolated, { timeout: 1000 });
  const requests = [];
  let storage = {};
  return {
    requests,
    storageSnapshot() { return structuredClone(storage); },
    advanceClock(milliseconds) {
      isolated.clockStep = milliseconds;
      vm.runInContext('Date.now = ((now, offset) => () => now() + offset)(Date.now, clockStep)', isolated, { timeout: 1000 });
      delete isolated.clockStep;
    },
    call(operation, params) {
      isolated.operation = operation;
      isolated.params = params;
      isolated.context = pluginContext(apiVersion, config, storage);
      let result = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin[operation](params, context))', isolated, { timeout: 1000 }));
      for (let hop = 0; result && result.request; hop++) {
        assert.ok(hop < 4);
        requests.push(result.request);
        assert.ok(/^https:\/\/(?:u|c)\.y\.qq\.com\//.test(result.request.url));
        const stage = result.state.stage;
        const fixture = respond ? respond(result.request, result.state) : stage === 'search' ? fixtures.search : stage === 'lyrics' ? fixtures.lyrics : stage === 'playback' ? playback : fixtures.detail;
        assert.ok(fixture, `Unexpected stage: ${stage}`);
        isolated.response = hostResponse(result.request, fixture);
        isolated.context = pluginContext(apiVersion, config, storage);
        isolated.state = result.state;
        result = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin.onResponse(operation, response, state, context))', isolated, { timeout: 1000 }));
      }
      if (result.storage) storage = result.storage;
      return Object.hasOwn(result, 'result') ? result.result : result;
    }
  };
}

const anonymous = create();
const search = anonymous.call('catalog.search', { query: '晴天', offset: 0, limit: 2 });
assert.equal(search.items.length, 2);
assert.equal(search.items[0].trackId, trackId);
assert.equal(search.items[0].artists[0], '周杰伦');
assert.equal(search.items[0].durationMs, 269000);
assert.notEqual(search.items[0].title, search.items[1].title);
assert.equal(anonymous.call('catalog.track', { trackId }).trackId, trackId);
const lyric = anonymous.call('lyrics.get', { trackId });
assert.match(lyric.text, /\[ti:晴天\]/);
assert.match(lyric.text, /\[ar:周杰伦\]/);
assert.deepEqual(anonymous.call('playback.resolve', { trackId, quality: 'hires' }), { error: 'AUTH_REQUIRED' });
assert.ok(anonymous.requests.every(request => !request.headers.Cookie));

function playback(data, config = session) {
  return create(config, { code: 0, playback: { code: 0, data } });
}
const file = `M500${fixtures.detail.detail.data.track_info.file.media_mid}.mp3`;
const permitted = playback({ expiration: 3600, midurlinfo: [{ songmid: trackId, filename: file, purl: file + '?fixture=1' }] });
const audio = permitted.call('playback.resolve', { trackId, quality: 'hires' });
assert.equal(audio.quality, 'standard');
assert.equal(audio.mimeType, 'audio/mpeg');
assert.equal(audio.cachePolicy, 'NO_STORE');
assert.equal(audio.uri, `https://ws6.stream.qqmusic.qq.com/${file}?fixture=1`);
assert.ok(!Object.keys(audio.headers).some(header => /cookie|authorization/i.test(header)));
assert.ok(permitted.requests.every(request => request.headers.Cookie === session.cookie));
const payload = requestPayload(permitted.requests.at(-1));
assert.equal(payload.playback.module, 'music.vkey.GetEVkey');
assert.equal(payload.playback.method, 'GetUrl');
assert.equal(payload.playback.param.uin, '123456');
assert.equal(payload.comm.uin, 123456);
assert.equal(payload.comm.g_tk, payload.comm.g_tk_new_20200303);
assert.equal(payload.comm.g_tk, 510355573);
assert.ok(!Object.hasOwn(payload.comm, 'authst'));
assert.ok(!Object.hasOwn(payload.playback.param, 'filename'));

for (const host of ['ws6.stream.qqmusic.qq.com', 'sjy6.stream.qqmusic.qq.com', 'regional-01.stream.qqmusic.qq.com', 'edge.region.stream.qqmusic.qq.com']) {
  for (const hostData of [{ sip: ['http://' + host + '/'] }, { thirdip: ['https://' + host + '/'] }]) {
    const selected = playback({ ...hostData, midurlinfo: [{ songmid: trackId, filename: file, purl: file + '?fixture=1' }] }).call('playback.resolve', { trackId });
    assert.equal(selected.uri, 'https://' + host + '/' + file + '?fixture=1');
    assert.equal(selected.cachePolicy, 'NO_STORE');
    assert.ok(!Object.keys(selected.headers).some(key => /cookie|authorization/i.test(key)));
  }
  const absolute = playback({ sip: ['https://not-declared.example/'], midurlinfo: [{ songmid: trackId, filename: file,
    purl: 'http://' + host + '/' + file + '?fixture=1' }] }).call('playback.resolve', { trackId });
  assert.equal(absolute.uri, 'https://' + host + '/' + file + '?fixture=1');
  for (const base of ['https://' + host + '.evil.example/', 'https://' + host + '@evil.example/',
    'https://evil@' + host + '/', 'https://' + host + ':443/', '//' + host + '/']) {
    const badBase = playback({ sip: [base], midurlinfo: [{ songmid: trackId, filename: file, purl: file }] });
    assert.deepEqual(badBase.call('playback.resolve', { trackId }), { error: 'UNSUPPORTED' });
    const badAbsolute = playback({ sip: ['https://' + host + '/'], midurlinfo: [{ songmid: trackId, filename: file, purl: base + file }] });
    assert.deepEqual(badAbsolute.call('playback.resolve', { trackId }), { error: base.startsWith('//') ? 'INVALID_RESPONSE' : 'UNSUPPORTED' });
  }
}
for (const host of ['stream.qqmusic.qq.com', 'evilstream.qqmusic.qq.com', 'ws6.stream.qqmusic.qq.com.evil.example',
  'stream.qqmusic.qq.com.evil.example', 'ws6..stream.qqmusic.qq.com', '-region.stream.qqmusic.qq.com',
  'region-.stream.qqmusic.qq.com', 'x'.repeat(64) + '.stream.qqmusic.qq.com']) {
  const rejectedBase = playback({ sip: ['https://' + host + '/'], midurlinfo: [{ songmid: trackId, filename: file, purl: file }] });
  assert.deepEqual(rejectedBase.call('playback.resolve', { trackId }), { error: 'UNSUPPORTED' });
  const rejectedAbsolute = playback({ sip: ['https://ws6.stream.qqmusic.qq.com/'],
    midurlinfo: [{ songmid: trackId, filename: file, purl: 'https://' + host + '/' + file }] });
  assert.deepEqual(rejectedAbsolute.call('playback.resolve', { trackId }), { error: 'UNSUPPORTED' });
}
const expired = create(session, { code: 0, playback: { code: 1000 } });
assert.deepEqual(expired.call('playback.resolve', { trackId }), { error: 'AUTH_EXPIRED' });
const trial = playback({ midurlinfo: [{ songmid: trackId, filename: 'RS02trial.mp3', purl: 'RS02trial.mp3' }] });
assert.deepEqual(trial.call('playback.resolve', { trackId }), { error: 'UNAVAILABLE' });
const disguisedTrial = playback({ midurlinfo: [{ songmid: trackId, filename: file, purl: '%52%5302trial.mp3' }] });
assert.deepEqual(disguisedTrial.call('playback.resolve', { trackId }), { error: 'UNAVAILABLE' });
const mismatchedFile = playback({ midurlinfo: [{ songmid: trackId, filename: file, purl: 'M800another-file.mp3' }] });
assert.deepEqual(mismatchedFile.call('playback.resolve', { trackId }), { error: 'INVALID_RESPONSE' });
const deniedItem = playback({ midurlinfo: [{ songmid: trackId, filename: file, purl: file, result: 1 }] });
assert.deepEqual(deniedItem.call('playback.resolve', { trackId }), { error: 'UNAVAILABLE' });
const deniedSession = playback({ retcode: 104009, midurlinfo: [{ songmid: trackId, filename: file, purl: file }] });
assert.deepEqual(deniedSession.call('playback.resolve', { trackId }), { error: 'AUTH_EXPIRED' });
const undeclared = playback({ sip: ['https://not-declared.example/'], midurlinfo: [{ songmid: trackId, filename: file, purl: file }] });
assert.deepEqual(undeclared.call('playback.resolve', { trackId }), { error: 'UNSUPPORTED' });
const unknownQuality = playback({ midurlinfo: [{ songmid: trackId, filename: 'unknown.bin', purl: 'unknown.bin' }] });
assert.deepEqual(unknownQuality.call('playback.resolve', { trackId }), { error: 'INVALID_RESPONSE' });
const longUin = playback({ midurlinfo: [] }, { cookie: 'qqmusic_key=fixture%40key', uin: '123456789012345678' });
longUin.call('playback.resolve', { trackId });
assert.equal(requestPayload(longUin.requests.at(-1)).comm.uin, '123456789012345678');
const cookieIdentity = playback({ midurlinfo: [] }, { cookie: 'uin=o%30%30%30%31%32%33%34%35%36; qqmusic_key=fixture%2540key', uin: '999999' });
cookieIdentity.call('playback.resolve', { trackId });
const cookiePayload = requestPayload(cookieIdentity.requests.at(-1));
assert.equal(cookiePayload.comm.uin, 123456);
assert.equal(cookiePayload.comm.g_tk, 510355573);
const wechat = playback({ midurlinfo: [] }, { cookie: 'uin=o123456; wxopenid=fixture-openid; wxuin=123456789012345678; qm_keyst=fixture-wechat-key' });
wechat.call('playback.resolve', { trackId });
const wechatPayload = requestPayload(wechat.requests.at(-1));
assert.equal(wechatPayload.comm.uin, '123456789012345678');
assert.equal(wechatPayload.playback.param.uin, '123456789012345678');
assert.equal(wechatPayload.comm.g_tk, 5381);
for (const [cookie, expectedUin, expectedCSRF] of [
  ['uin=o123456; qqmusic_key=fixture%40key; qm_keyst=first-qm; uin=o654321; qqmusic_key=last-key; qm_keyst=last-qm', 123456, 510355573],
  ['uin=o123456; wxopenid=first-openid; wxuin=123456789012345678; qqmusic_key=fixture%40key; qm_keyst=first-qm; uin=o654321; wxopenid=; wxuin=987654321098765432; qqmusic_key=last-key; qm_keyst=', '123456789012345678', 510355573],
  ['uin=o123456; qm_keyst=first-qm; qm_keyst=', 123456, 5381],
  ['uin=o123456; qqmusic_key=; qqmusic_key=last-key; qm_keyst=first-qm', 123456, 5381],
]) {
  const duplicate = playback({ midurlinfo: [] }, { cookie });
  duplicate.call('playback.resolve', { trackId });
  assert.equal(duplicate.requests.length, 2);
  const outgoing = duplicate.requests.at(-1);
  const payload = requestPayload(outgoing);
  assert.equal(payload.comm.uin, expectedUin);
  assert.equal(payload.playback.param.uin, String(expectedUin));
  assert.equal(payload.comm.g_tk, expectedCSRF);
  assert.equal(payload.comm.g_tk_new_20200303, expectedCSRF);
  assert.ok(duplicate.requests.every(request => request.headers.Cookie === cookie));
}
const emptyFirstKey = playback({ midurlinfo: [] }, { cookie: 'uin=o123456; qm_keyst=; qm_keyst=last-qm' });
assert.deepEqual(emptyFirstKey.call('playback.resolve', { trackId }), { error: 'AUTH_EXPIRED' });
assert.equal(emptyFirstKey.requests.length, 0);
const aacFile = `C400${fixtures.detail.detail.data.track_info.file.media_mid}.m4a`;
const aac = playback({ midurlinfo: [{ songmid: trackId, filename: aacFile, purl: aacFile }] }).call('playback.resolve', { trackId });
assert.equal(aac.mimeType, 'audio/mp4');
assert.equal(aac.quality, 'standard');
assert.ok(!Object.hasOwn(aac, 'contentLength'));
const injected = create({ cookie: session.cookie + '\r\nX-Injected: yes' });
assert.deepEqual(injected.call('playback.resolve', { trackId }), { error: 'INVALID_RESPONSE' });
assert.equal(injected.requests.length, 0);
assert.deepEqual(manifest.permissions.network, ['*.qq.com', '*.gtimg.com', '*.gtimg.cn', '*.cdn-go.cn', '*.qpic.cn', '*.idqqimg.cn', '*.stream.qqmusic.qq.com']);
assert.ok(manifest.config.every(field => !field.required));

// API2 exercises captured public metadata and synthetic private-account responses.
// This runner never makes network calls or writes to a QQ account.
const captured = name => JSON.parse(fs.readFileSync(path.join(root, `fixtures/captured-${name}.json`), 'utf8'));
const publicFixtures = Object.fromEntries(['feed', 'category', 'playlist', 'chart', 'album', 'album-tracks', 'artist', 'artist-tracks', 'artist-albums', 'search-artist', 'search-album', 'search-playlist'].map(name => [name, captured(name)]));
function publicResponse(request, state) {
  if (state.stage === 'search') return state.type === 'track' ? fixtures.search : publicFixtures['search-' + state.type];
  if (state.stage === 'feed') {
    const keys = Object.keys(requestPayload(request)).filter(key => key !== 'comm');
    return Object.fromEntries([['code', 0], ...keys.map(key => [key, key === 'category' ? publicFixtures.category.category : publicFixtures.feed[key]])]);
  }
  if (state.stage === 'playlist.get' || state.stage === 'playlist.tracks') return publicFixtures[state.chart ? 'chart' : 'playlist'];
  const map = { 'album.get': 'album', 'album.tracks': 'album-tracks', 'artist.get': 'artist', 'artist.tracks': 'artist-tracks', 'artist.albums': 'artist-albums' };
  if (map[state.stage]) return publicFixtures[map[state.stage]];
  return fixtures.detail;
}
const catalog = create({}, null, 2, publicResponse);
const typedSearch = catalog.call('catalog.search', { query: '晴天', type: 'track', offset: 0, limit: 2 });
assert.equal(typedSearch.items[0].type, 'track');
assert.equal(typedSearch.items[0].track.trackId, trackId);
assert.equal(typedSearch.items[0].track.artists[0].artistId, '0025NhlN2yWrP4');
assert.equal(typedSearch.items[0].track.album.albumId, '000MkMni19ClKG');
for (const type of ['artist', 'album', 'playlist']) {
  const page = catalog.call('catalog.search', { query: '周杰伦', type, offset: 0, limit: 2 });
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every(value => value.type === type));
}
const home = catalog.call('feed.home', { offset: 0, limit: 3 });
assert.deepEqual(home.sections.map(section => section.id), ['recommend', 'songs', 'albums']);
assert.ok(home.sections.every(section => section.items.length > 0));
const recommended = home.sections[0].items[0].playlist;
assert.equal(recommended.playlistId, '8044204090');
assert.equal(catalog.call('playlist.get', { playlistId: recommended.playlistId }).title, recommended.title);
assert.equal(recommended.playCount, undefined);
for (const field of ['access_num', 'listennum', 'listen_num']) {
  for (const count of [0, 4500000000, '4500000000']) {
    const counted = structuredClone(publicFixtures.playlist);
    counted.playlist.data.dirinfo[field] = count;
    assert.equal(create({}, null, 2, () => counted).call('playlist.get', { playlistId: recommended.playlistId }).playCount, Number(count));
  }
}
for (const count of [undefined, null, -1, 1.5, true, 'unknown', Number.MAX_SAFE_INTEGER + 1]) {
  const unknown = structuredClone(publicFixtures.playlist);
  unknown.playlist.data.dirinfo.listennum = count;
  assert.equal(create({}, null, 2, () => unknown).call('playlist.get', { playlistId: recommended.playlistId }).playCount, undefined);
}
const countedHome = create({}, null, 2, (request, state) => {
  const response = structuredClone(publicResponse(request, state));
  if (state.stage === 'feed') response.recommend.data.List[0].Playlist.basic.access_num = 4500000000;
  return response;
}).call('feed.home', { offset: 0, limit: 3 });
assert.equal(countedHome.sections[0].items[0].playlist.playCount, 4500000000);
const countedDiscovery = create({}, null, 2, (request, state) => {
  const response = structuredClone(publicResponse(request, state));
  if (state.stage === 'feed') response.category.data.v_playlist[0].listen_num = 0;
  return response;
}).call('feed.discover', { offset: 0, limit: 3 });
assert.equal(countedDiscovery.sections[0].items[0].playlist.playCount, 0);
const playlistTracks = catalog.call('playlist.tracks', { playlistId: recommended.playlistId, offset: 0, limit: 3 });
assert.equal(playlistTracks.items.length, 3);
assert.equal(playlistTracks.items[0].trackId, '002eDlpu4U223F');
assert.equal(playlistTracks.hasMore, true);
const filteredPageFixture = structuredClone(publicFixtures.playlist);
filteredPageFixture.playlist.data.songlist[1].mid = '';
const filteredPage = create({}, null, 2, () => filteredPageFixture).call('playlist.tracks', { playlistId: recommended.playlistId, offset: 0, limit: 3 });
assert.equal(filteredPage.items.length, 2);
assert.equal(filteredPage.nextCursor, '3');
assert.equal(home.sections[0].layout, 'hero');
assert.deepEqual(home.categories, []);
assert.equal(home.hasMore, false);
assert.equal(home.nextCursor, undefined);
const newAlbums = catalog.call('feed.discover', { categoryId: 'albums', offset: 0, limit: 3 });
assert.equal(newAlbums.hasMore, true);
assert.equal(newAlbums.nextCursor, '3');
const discover = catalog.call('feed.discover', { offset: 0, limit: 3 });
assert.deepEqual(discover.sections.map(section => section.id), ['category']);
assert.equal(discover.categories[0].id, '3317');
const chart = catalog.call('feed.discover', { categoryId: 'charts', offset: 0, limit: 3 }).sections[0].items[0].playlist;
assert.equal(chart.playlistId, 'chart:62');
assert.equal(catalog.call('playlist.get', { playlistId: chart.playlistId }).playlistId, chart.playlistId);
assert.equal(catalog.call('playlist.tracks', { playlistId: chart.playlistId, offset: 0, limit: 3 }).items.length, 3);
const album = home.sections.find(section => section.id === 'albums').items[0].album;
assert.equal(catalog.call('album.get', { albumId: album.albumId }).albumId, album.albumId);
assert.equal(catalog.call('album.tracks', { albumId: album.albumId, offset: 0, limit: 3 }).items.length, 2);
const albumId = publicFixtures.album.album.data.basicInfo.albumMid;
const fullAlbumSongs = Array.from({ length: 45 }, (_, index) => ({ songInfo: {
  ...publicFixtures['album-tracks'].albumTracks.data.songList[0].songInfo,
  mid: 'AlbumTrack' + index, title: 'Album recording ' + index,
} }));
let countState;
const fullAlbum = create({}, null, 2, (request, state) => {
  if (state.stage === 'album.get') return publicFixtures.album;
  assert.equal(state.stage, 'album.tracks');
  const params = requestPayload(request).albumTracks.param;
  if (state.albumMetadata) {
    countState = structuredClone(state);
    assert.equal(params.num, 1);
    assert.equal(params.begin, 0);
    assert.equal(request.errorResponse, true);
  }
  return { code: 0, albumTracks: { code: 0, data: {
    albumMid: albumId, totalNum: fullAlbumSongs.length,
    songList: fullAlbumSongs.slice(params.begin, params.begin + params.num),
  } } };
});
assert.equal(fullAlbum.call('album.get', { albumId }).trackCount, 45);
assert.equal(fullAlbum.requests.length, 2, 'Only missing album totals need one small count request');
const firstAlbumPage = fullAlbum.call('album.tracks', { albumId, offset: 0, limit: 30 });
assert.equal(firstAlbumPage.items.length, 30);
assert.equal(firstAlbumPage.hasMore, true);
assert.equal(firstAlbumPage.nextCursor, '30');
const secondAlbumPage = fullAlbum.call('album.tracks', { albumId, offset: 30, cursor: firstAlbumPage.nextCursor, limit: 30 });
assert.equal(secondAlbumPage.items.length, 15);
assert.equal(secondAlbumPage.hasMore, false);
assert.equal(secondAlbumPage.nextCursor, undefined);
assert.deepEqual([...firstAlbumPage.items, ...secondAlbumPage.items].map(value => value.trackId), fullAlbumSongs.map(value => value.songInfo.mid));
for (const field of ['totalNum', 'song_num']) {
  for (const count of [0, '0', 45, '45']) {
    const response = structuredClone(publicFixtures.album);
    response.album.data.basicInfo[field] = count;
    const knownAlbum = create({}, null, 2, () => response);
    assert.equal(knownAlbum.call('album.get', { albumId }).trackCount, Number(count));
    assert.equal(knownAlbum.requests.length, 1, 'A known zero is not a missing album total');
  }
}
for (const count of [0, '0']) {
  const emptyAlbum = create({}, null, 2, (_, state) => state.stage === 'album.get' ? publicFixtures.album :
    { code: 0, albumTracks: { code: 0, data: { albumMid: albumId, totalNum: count, songList: [] } } });
  assert.equal(emptyAlbum.call('album.get', { albumId }).trackCount, 0);
  assert.equal(emptyAlbum.requests.length, 2);
}
const topLevelCount = structuredClone(publicFixtures.album);
topLevelCount.album.data.totalNum = 45;
const topLevelAlbum = create({}, null, 2, () => topLevelCount);
assert.equal(topLevelAlbum.call('album.get', { albumId }).trackCount, 45);
assert.equal(topLevelAlbum.requests.length, 1);
const optionalCountFailure = create({}, null, 2, (_, state) => state.stage === 'album.get' ? publicFixtures.album : { code: 1000 });
const retainedAlbum = optionalCountFailure.call('album.get', { albumId });
assert.equal(retainedAlbum.albumId, albumId);
assert.equal(retainedAlbum.trackCount, undefined);
assert.equal(optionalCountFailure.requests.length, 2);
const countCallback = vm.createContext({});
vm.runInContext(source, countCallback, { timeout: 1000 });
countCallback.state = countState;
countCallback.context = pluginContext(2, {}, {});
for (const error of ['NETWORK', 'TIMEOUT']) {
  countCallback.response = { status: 0, body: '', error };
  const fallback = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin.onResponse("album.get", response, state, context))', countCallback, { timeout: 1000 }));
  assert.equal(fallback.result.albumId, albumId);
  assert.equal(fallback.result.trackCount, undefined);
}
for (const count of [undefined, null, -1, 1.5, true, 'unknown', 2147483648]) {
  const unknownAlbum = create({}, null, 2, (_, state) => {
    if (state.stage === 'album.get') {
      const response = structuredClone(publicFixtures.album);
      response.album.data.basicInfo.totalNum = count;
      return response;
    }
    return { code: 0, albumTracks: { code: 0, data: { albumMid: albumId, totalNum: count, songList: [] } } };
  });
  assert.equal(unknownAlbum.call('album.get', { albumId }).trackCount, undefined);
  assert.equal(unknownAlbum.requests.length, 2);
}
assert.equal(catalog.call('artist.get', { artistId: '0025NhlN2yWrP4' }).name, '周杰伦');
assert.equal(catalog.call('artist.tracks', { artistId: '0025NhlN2yWrP4', offset: 0, limit: 3 }).items[0].trackId, trackId);
assert.equal(catalog.call('artist.albums', { artistId: '0025NhlN2yWrP4', offset: 0, limit: 3 }).items[0].albumId, '0041WVfh2vtlJE');
const category = catalog.call('feed.discover', { categoryId: '3056', offset: 0, limit: 3 });
assert.equal(category.sections.length, 1);
assert.equal(category.sections[0].id, 'category');
assert.equal(category.sections[0].items[0].type, 'playlist');
assert.ok(category.sections[0].items[0].playlist.artworkUrl.startsWith('https://p.qpic.cn/'));
assert.ok(catalog.requests.every(request => !request.headers.Cookie));
assert.deepEqual(create({}, null, 2).call('account.get', {}), null);
for (const operation of manifest.capabilities.filter(operation => /^(library\.|track\.(?:like|liked)$|collection\.|playlist\.(?:create|update|delete|addTracks|removeTracks)$)/.test(operation))) {
  const denied = create({}, null, 2);
  assert.deepEqual(denied.call(operation, {}), { error: 'AUTH_REQUIRED' }, operation);
  assert.equal(denied.requests.length, 0);
}
const signedInPublicSearch = create(session, null, 2, (_request, state) => ({ code: 0, request: { code: 0, data: {
  body: { song: { list: fixtures.search.request.data.body.item_song } }, meta: fixtures.search.request.data.meta,
} } }));
assert.equal(signedInPublicSearch.call('catalog.search', { query: 'Fixture', type: 'track', offset: 0, limit: 3 }).items[0].type, 'track');
assert.equal(requestPayload(signedInPublicSearch.requests[0]).request.method, 'DoSearchForQQMusicDesktop');
assert.ok(signedInPublicSearch.requests.every(request => request.headers.Cookie === session.cookie));
const OWN_PLAYLIST_ID = '9900112233';
const OWNER_ENCRYPTED_UIN = 'fixture-owner-123456';
const profile = { code: 0, data: { creator: { uin: '123456', encrypt_uin: OWNER_ENCRYPTED_UIN,
  nick: 'Fixture account', headpic: 'https://q.qlogo.cn/fixture' }, mymusic: [{ type: 1, id: '99887766', num0: 3 }] } };
const ownCreated = { code: 0, data: { hostuin: '123456', encrypt_uin: OWNER_ENCRYPTED_UIN, totoal: 3, disslist: [
  { tid: 123, dirid: 201, diss_name: 'Favorites', song_cnt: 3 },
  { tid: Number(OWN_PLAYLIST_ID), dirid: 7, diss_name: 'My playlist', song_cnt: 3, uin: '123456' },
  { tid: 456, dirid: 8, diss_name: 'Next playlist', song_cnt: 0, uin: '123456' },
] } };
// Synthetic ownership metadata is independent of the captured public, other-user playlist.
const ownPlaylist = { code: 0, playlist: { code: 0, data: { code: 0, dirinfo: {
  id: Number(OWN_PLAYLIST_ID), dirid: 7, title: 'My playlist', owndir: 1, host_uin: '123456',
  encrypt_uin: OWNER_ENCRYPTED_UIN, desc: 'Keep this description', picurl: '', picurl2: '', vec_tagid: [], show: 1,
}, songlist: [], total_song_num: 0 } } };
const requestsFor = [];
function privateResponse(request, state) {
  requestsFor.push({ request, state });
  const envelope = data => ({ code: 0, [state.key]: { code: 0, data } });
  if (state.stage === 'account' || state.stage === 'liked-profile' || state.stage === 'owner-profile') return profile;
  if (state.stage === 'liked-tracks') {
    assert.equal(requestPayload(request).playlist.param.disstid, 99887766);
    return publicFixtures.playlist;
  }
  if (state.stage === 'library.createdPlaylists' || state.stage === 'owner-list') return ownCreated;
  if (state.stage === 'library.savedPlaylists') return { code: 0, data: { totaldiss: 2, cdlist: [{ dissid: '8044204090', dissname: 'Saved one', songnum: 3 }, { dissid: '8870221359', dissname: 'Saved two', songnum: 1 }] } };
  if (state.stage === 'library.savedAlbums') return { code: 0, data: { totalalbum: 1, albumlist: [{ albummid: '000LFWfZ3G7QtG', albumname: 'Saved album', singer: '徐艺洋' }] } };
  if (state.stage === 'library.followedArtists') return envelope({ List: [{ MID: '0025NhlN2yWrP4', Name: '周杰伦', AvatarUrl: 'https://y.gtimg.cn/fixture' }], HasMore: false });
  if (state.stage === 'saved') return envelope(state.type === 'artist' ? { map_singer_status: { [state.id]: 1 } } : { m_fan: { [state.id]: 1 } });
  if (state.stage === 'created') return envelope({ result: { tid: 1122334455, dirId: 9 } });
  if (state.stage === 'owned-update-detail') return ownPlaylist;
  if (state.stage === 'playlist-song-details') return { code: 0, song0: fixtures.detail.detail };
  if (state.stage === 'mutation') return envelope({ result: 0 });
  if (state.stage === 'like-detail') return fixtures.detail;
  throw new Error(`Unhandled private fixture stage: ${state.stage}`);
}
const personal = create(session, null, 2, privateResponse);
assert.deepEqual(personal.call('account.get', {}), { accountId: 'enc:' + OWNER_ENCRYPTED_UIN, displayName: 'Fixture account', avatarUrl: 'https://q.qlogo.cn/fixture' });
const profileRequest = new URL(personal.requests.at(-1).url);
assert.equal(profileRequest.hostname, 'c.y.qq.com');
assert.equal(profileRequest.pathname, '/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
assert.equal(profileRequest.searchParams.get('userid'), '0');
assert.equal(profileRequest.searchParams.get('ct'), '20');
assert.equal(profileRequest.searchParams.get('loginUin'), '123456');
assert.equal(profileRequest.searchParams.get('uin'), '123456');
assert.equal(profileRequest.searchParams.get('cv'), '4747474');
assert.equal(profileRequest.searchParams.get('g_tk'), '510355573');
for (const [config, expectedUin] of [
  [{ cookie: 'uin=o000123456; qqmusic_key=fixture%40key' }, '123456'],
  [{ cookie: 'uin=o123456; wxopenid=fixture-openid; wxuin=123456789012345678; qm_keyst=fixture-wechat-key' }, '123456789012345678'],
]) {
  const self = create(config, null, 2, () => ({ ...profile, data: { ...profile.data,
    creator: { ...profile.data.creator, uin: expectedUin } } }));
  assert.equal(self.call('account.get', {}).accountId, 'enc:' + OWNER_ENCRYPTED_UIN);
  const query = new URL(self.requests[0].url).searchParams;
  assert.equal(query.get('uin'), expectedUin);
  assert.equal(query.get('loginUin'), expectedUin);
  assert.equal(query.get('cv'), '4747474');
  assert.equal(query.get('userid'), '0');
  assert.equal(query.get('ct'), '20');
}
assert.equal(personal.call('library.likedTracks', { offset: 0, limit: 3 }).items[0].type, 'track');
const created = personal.call('library.createdPlaylists', { offset: 0, limit: 2 });
assert.equal(created.items.length, 2);
assert.equal(created.items[0].playlist.playlistId, OWN_PLAYLIST_ID);
assert.deepEqual(created.items[0].playlist.editableActions, ['update', 'delete', 'addTracks', 'removeTracks']);
assert.equal(created.hasMore, false);
assert.equal(created.nextCursor, undefined);
// Server positions include up to nine system directories, independently of visible items.
const rawDirectories = [...Array.from({ length: 9 }, (_, index) => ({ tid: 2000000000 + index, dirid: 201 + index, diss_name: 'System directory' })),
  ...Array.from({ length: 5 }, (_, index) => ({ tid: 1000000000 + index, dirid: 1 + index, diss_name: 'Custom ' + index }))];
const directoryPages = create(session, null, 2, (request, state) => {
  if (state.stage === 'owner-profile') return profile;
  const url = new URL(request.url);
  const start = Number(url.searchParams.get('sin'));
  const size = Number(url.searchParams.get('size'));
  assert.ok(size >= 30);
  return { code: 0, data: { encrypt_uin: OWNER_ENCRYPTED_UIN, totoal: rawDirectories.length, disslist: rawDirectories.slice(start, start + size) } };
});
const directoryFirst = directoryPages.call('library.createdPlaylists', { offset: 0, limit: 3 });
assert.equal(directoryFirst.items.length, 3);
assert.equal(directoryFirst.nextCursor, '12');
const directoryNext = directoryPages.call('library.createdPlaylists', { offset: directoryFirst.items.length, limit: 3, cursor: directoryFirst.nextCursor });
assert.equal(directoryNext.items.length, 2);
assert.equal(directoryNext.hasMore, false);
assert.equal(new URL(directoryPages.requests.filter(request => new URL(request.url).pathname.endsWith('fcg_user_created_diss'))[1].url).searchParams.get('sin'), '12');
assert.deepEqual([...directoryFirst.items, ...directoryNext.items].map(value => value.playlist.playlistId),
  Array.from({ length: 5 }, (_, index) => String(1000000000 + index)));
const cappedDirectories = [...rawDirectories.slice(0, 9), ...Array.from({ length: 35 }, (_, index) =>
  ({ tid: 3000000000 + index, dirid: 1 + index, diss_name: 'Capped custom ' + index }))];
const cappedPages = create(session, null, 2, (request, state) => {
  if (state.stage === 'owner-profile') return profile;
  const start = Number(new URL(request.url).searchParams.get('sin'));
  return { code: 0, data: { encrypt_uin: OWNER_ENCRYPTED_UIN, totoal: cappedDirectories.length, disslist: cappedDirectories.slice(start, start + 30) } };
});
const cappedFirst = cappedPages.call('library.createdPlaylists', { offset: 0, limit: 30 });
assert.equal(cappedFirst.items.length, 30);
assert.equal(cappedFirst.nextCursor, '39');
assert.equal(cappedPages.requests.length, 3);
const cappedNext = cappedPages.call('library.createdPlaylists', { offset: 30, limit: 30, cursor: cappedFirst.nextCursor });
assert.equal(cappedNext.items.length, 5);
assert.equal(cappedNext.hasMore, false);
assert.deepEqual([...cappedFirst.items, ...cappedNext.items].map(value => value.playlist.playlistId),
  Array.from({ length: 35 }, (_, index) => String(3000000000 + index)));
const systemOnly = create(session, null, 2, (_, state) => state.stage === 'owner-profile' ? profile : ({ code: 0, data: { encrypt_uin: OWNER_ENCRYPTED_UIN, totoal: 9, disslist: rawDirectories.slice(0, 9) } }));
assert.deepEqual(systemOnly.call('library.createdPlaylists', { offset: 0, limit: 3 }), { items: [], hasMore: false });
for (const cursor of ['', '-1', '1.5', 'Infinity', '2147483648', '9007199254740992', 12]) {
  const badCursor = create(session, null, 2, () => { throw new Error('An invalid cursor must not issue a request'); });
  assert.deepEqual(badCursor.call('library.createdPlaylists', { offset: 0, limit: 3, cursor }), { error: 'INVALID_RESPONSE' });
  assert.equal(badCursor.requests.length, 0);
}
const saved = personal.call('library.savedPlaylists', { offset: 0, limit: 2 });
assert.ok(saved.items.every(value => !value.playlist.editableActions));
assert.equal(personal.call('library.savedAlbums', { offset: 0, limit: 2 }).items[0].album.albumId, '000LFWfZ3G7QtG');
assert.equal(personal.call('library.followedArtists', { offset: 0, limit: 2 }).items[0].artist.artistId, '0025NhlN2yWrP4');
assert.equal(personal.call('track.liked', { trackId }), true);
for (const type of ['playlist', 'album', 'artist']) {
  const id = { playlist: '8044204090', album: '000LFWfZ3G7QtG', artist: '0025NhlN2yWrP4' }[type];
  assert.equal(personal.call('collection.saved', { type, id }), true);
  for (const saved of [true, false]) assert.equal(personal.call('collection.save', { type, id, saved }), true);
}
assert.equal(personal.call('track.like', { trackId, liked: true }), true);
let last = requestPayload(personal.requests.at(-1)).mutation;
assert.equal(last.method, 'AddSonglist');
assert.equal(last.param.dirId, 201);
assert.deepEqual(last.param.v_songInfo, [{ songType: 0, songId: 97773 }]);
assert.equal(personal.call('track.like', { trackId, liked: false }), true);
assert.equal(requestPayload(personal.requests.at(-1)).mutation.method, 'DelSonglist');
assert.equal(personal.call('playlist.create', { title: 'A new playlist', description: 'Fixture' }).playlistId, '1122334455');
last = requestPayload(personal.requests.at(-1)).mutation;
assert.equal(last.module, 'music.musicasset.PlaylistBaseWrite');
assert.equal(last.method, 'AddPlaylist');
assert.equal(last.param.dirName, 'A new playlist');
assert.equal(personal.call('playlist.update', { playlistId: OWN_PLAYLIST_ID, title: 'New title' }), true);
last = requestPayload(personal.requests.at(-1)).mutation;
assert.equal(last.method, 'EditPlaylist');
assert.equal(last.param.dirId, 7);
assert.notEqual(last.param.dirId, 8044204090);
assert.equal(last.param.dirNewDesc, 'Keep this description');
assert.equal(last.param.mask, 95);
for (const [operation, method] of [['playlist.addTracks', 'AddSonglist'], ['playlist.removeTracks', 'DelSonglist']]) {
  assert.equal(personal.call(operation, { playlistId: OWN_PLAYLIST_ID, trackIds: [trackId] }), true);
  last = requestPayload(personal.requests.at(-1)).mutation;
  assert.equal(last.method, method);
  assert.equal(last.param.dirId, 7);
  assert.deepEqual(last.param.v_songInfo, [{ songType: 0, songId: 97773 }]);
}
assert.equal(personal.call('playlist.delete', { playlistId: OWN_PLAYLIST_ID }), true);
assert.equal(requestPayload(personal.requests.at(-1)).mutation.param.dirId, 7);
const otherOwner = create(session, null, 2, () => publicFixtures.playlist);
assert.deepEqual(otherOwner.call('playlist.delete', { playlistId: OWN_PLAYLIST_ID }), { error: 'INVALID_RESPONSE' });
assert.equal(otherOwner.requests.length, 1);
assert.ok(!Object.hasOwn(manifest, 'playlist.reorderTracks'));
assert.ok(!manifest.capabilities.includes('playlist.reorderTracks'));
assert.equal(manifest.apiVersion, 2);
assert.deepEqual(manifest.searchTypes, ['track', 'playlist', 'album', 'artist']);
assert.ok(personal.requests.every(request => request.headers.Cookie === session.cookie));
const rejected104009 = create(session, { code: 0, playback: { code: 104009, data: { retcode: 104009 } } });
assert.deepEqual(rejected104009.call('playback.resolve', { trackId }), { error: 'AUTH_EXPIRED' });
const expiredLibrary = create(session, null, 2, () => ({ code: -1, subcode: -2, data: {} }));
assert.deepEqual(expiredLibrary.call('library.savedPlaylists', { offset: 0, limit: 3 }), { error: 'AUTH_EXPIRED' });
console.log('QQ adapter: API1/2 public catalog, navigation, own-session library, offline mutation contracts, playback guards and credential isolation passed.');

// Published MIT upstream vectors independently validate the production protocol.
const transportVectors = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/transport-vectors.json'), 'utf8'));
for (const vector of transportVectors.sign) assert.ok(signBody(vector.message) === vector.sign, 'Upstream signature vector mismatch');
for (const vector of transportVectors.requests) {
  const bytes = unbase64(vector.requestBase64);
  assert.ok(encryptBody(vector.message, bytes.slice(0, 12)) === vector.requestBase64, 'Upstream AES-GCM vector mismatch');
  const decipher = createDecipheriv('aes-128-gcm', PUBLIC_AG1.aesKey, bytes.slice(0, 12));
  decipher.setAuthTag(bytes.slice(-16));
  assert.ok(Buffer.concat([decipher.update(bytes.slice(12, -16)), decipher.final()]).toString('utf8') === vector.message, 'Independent AES-GCM reference mismatch');
}
for (const vector of transportVectors.responses) assert.ok(decodeHostResponse({ body: '', bodyBase64: vector.responseBase64 }).body === vector.message, 'Upstream response vector mismatch');
for (const message of ['{"code":1000}', '{"code":104009}', '{"code":2001}', '{"code":0,"data":{}}']) {
  assert.deepEqual(decodeHostResponse({ body: '', bodyBase64: Buffer.from(message).toString('base64') }), { body: message });
  assert.deepEqual(decodeHostResponse({ body: message }), { body: message });
}
for (const response of [{ body: '<html>invalid</html>' }, { body: '', bodyBase64: 'bad=' }, { body: '', bodyBase64: '!!!!' }]) {
  assert.deepEqual(decodeHostResponse(response), { error: 'INVALID_RESPONSE' });
}
for (const message of ['plain ASCII', '中文 😀', '\ud800', '\udc00', 'quote " slash \\']) {
  assert.deepEqual(Buffer.from(utf8Bytes(message)), Buffer.from(message, 'utf8'));
  assert.equal(utf8Text(utf8Bytes(message)), Buffer.from(message, 'utf8').toString('utf8'));
}
// Cover strict UTF-8 boundaries, including pairs spanning a decoder block.
const utf8Boundaries = String.fromCodePoint(0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff);
for (const message of [utf8Boundaries, 'a'.repeat(4095) + '😀中', '中😀x'.repeat(65536)]) {
  assert.equal(utf8Text(new Uint8Array(Buffer.from(message))), message);
}
for (const bytes of [
  [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xc2, 0x7f],
  [0xe0, 0x9f, 0xbf], [0xe0, 0xa0], [0xed, 0xa0, 0x80], [0xef, 0xbf],
  [0xf0, 0x8f, 0xbf, 0xbf], [0xf0, 0x90, 0x80], [0xf4, 0x90, 0x80, 0x80],
  [0xf5, 0x80, 0x80, 0x80], [0xff], [0xe2, 0x28, 0xa1],
]) assert.throws(() => utf8Text(new Uint8Array(bytes)), URIError);
// A host-sized Unicode response exercises the shipped binary decoder, not only
// the small upstream vectors. Keep the synthetic content free of account data.
const largePublicBody = JSON.stringify({ code: 0, data: { text: '中😀x'.repeat(65536) } });
const largeResponse = hostResponse({ responseEncoding: 'base64' }, JSON.parse(largePublicBody));
assert.equal(decodeHostResponse(largeResponse).body, largePublicBody);
const random = randomBytes(256);
assert.deepEqual(Buffer.from(unbase64(base64(random))), random);
const plainRequest = { url: 'https://u.y.qq.com/cgi-bin/musicu.fcg', method: 'POST', headers: {}, body: '{"code":0}' };
for (const context of [{}, { secureRandomBase64: '' }, { secureRandomBase64: Buffer.alloc(11).toString('base64') }, { secureRandomBase64: 'invalid' }]) {
  assert.deepEqual(encodeRequest(plainRequest, context), { error: 'UNSUPPORTED' });
}
const boundedContext = { secureRandomBase64: Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('base64') };
const nonces = new Set();
for (let i = 0; i < 21; i++) {
  const request = encodeRequest(plainRequest, boundedContext);
  assert.equal(request.responseEncoding, 'base64');
  nonces.add(request.body.slice(0, 16));
}
assert.equal(nonces.size, 21);
assert.deepEqual(encodeRequest(plainRequest, boundedContext), { error: 'UNSUPPORTED' });
assert.ok(fs.statSync(path.join(root, 'index.js')).size <= 256 * 1024);
console.log('QQ AG1: independent public SHA-1/AES-GCM/XOR vectors, plain authorization errors, bounded host entropy and binary framing passed.');

// Exercise the shipped callback directly with unencoded QQ authorization failures.
for (const [config, code, expected] of [[{}, 1000, 'AUTH_REQUIRED'], [session, 104009, 'AUTH_EXPIRED']]) {
  const isolated = vm.createContext({});
  vm.runInContext(source, isolated, { timeout: 1000 });
  isolated.context = pluginContext(2, config, {});
  isolated.params = { trackId };
  const pending = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin["catalog.track"](params, context))', isolated));
  isolated.state = pending.state;
  isolated.response = { status: 200, body: '', bodyBase64: Buffer.from(JSON.stringify({ code })).toString('base64') };
  const result = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin.onResponse("catalog.track", response, state, context))', isolated));
  assert.ok(result.error === expected, 'Plain QQ authorization errors must retain their authentication meaning');
}

// A global playlist ID is never translated to an account-local directory by public metadata.
const spoofedPublic = structuredClone(publicFixtures.playlist);
spoofedPublic.playlist.data.dirinfo.owndir = 1;
spoofedPublic.playlist.data.dirinfo.dirid = 7;
const publicWithOwnFlag = create(session, null, 2, (request, state) => {
  if (state.stage === 'playlist.get') return spoofedPublic;
  return privateResponse(request, state);
});
const publicMetadata = publicWithOwnFlag.call('playlist.get', { playlistId: '8044204090' });
assert.ok(!publicMetadata.editableActions);
const provenOwn = create(session, null, 2, (request, state) => state.stage === 'playlist.get' ? ownPlaylist : privateResponse(request, state));
assert.deepEqual(provenOwn.call('playlist.get', { playlistId: OWN_PLAYLIST_ID }).editableActions,
  ['update', 'delete', 'addTracks', 'removeTracks']);
assert.equal(provenOwn.requests.length, 3);

function isMutationRequest(request) {
  if (new URL(request.url).hostname !== 'u.y.qq.com') return false;
  return Object.values(requestPayload(request)).some(value => value && typeof value === 'object' &&
    (String(value.module).includes('Write') || value.method === 'cgi_concern_user_v2'));
}
const ownershipCases = [
  ['missing profile owner', (p, _) => { delete p.data.creator.encrypt_uin; }],
  ['wrong profile owner', (p, _) => { p.data.creator.uin = '654321'; }],
  ['redacted profile/list identity mismatch', (p, _) => { p.data.creator.uin = 0; p.data.creator.encrypt_uin = 'profile-owner-B'; }],
  ['malformed profile owner', (p, _) => { p.data.creator.uin = false; }],
  ['malformed redacted profile owner', (p, _) => { p.data.creator.uin = '00'; }],
  ['empty encrypted profile owner', (p, _) => { p.data.creator.uin = 0; p.data.creator.encrypt_uin = ''; }],
  ['whitespace encrypted profile owner', (p, _) => { p.data.creator.uin = 0; p.data.creator.encrypt_uin = ' '; }],
  ['missing list owner', (_, list) => { delete list.data.encrypt_uin; }],
  ['wrong encrypted list owner', (_, list) => { list.data.encrypt_uin = 'another-fixture-owner'; }],
  ['wrong numeric list owner', (_, list) => { list.data.hostuin = '654321'; }],
  ['same directory under another global ID', (_, list) => { list.data.disslist[1].tid = 8877665544; }],
  ['duplicate global ID', (_, list) => { list.data.disslist[2].tid = Number(OWN_PLAYLIST_ID); }],
  ['ambiguous directory', (_, list) => { list.data.disslist[2].dirid = 7; }],
  ['incomplete own catalog', (_, list) => { list.data.totoal = 1001; }],
  ['missing complete count', (_, list) => { delete list.data.totoal; }],
  ['wrong row creator', (_, list) => { list.data.disslist[1].uin = '654321'; }],
  ['system directory', (_, list) => { list.data.disslist[1].dirid = 201; }],
  ['boolean directory', (_, list) => { list.data.disslist[1].dirid = true; }],
];
for (const [label, change] of ownershipCases) {
  const p = structuredClone(profile), list = structuredClone(ownCreated);
  change(p, list);
  const denied = create(session, null, 2, (_, state) => {
    if (state.stage === 'owner-profile') return p;
    if (state.stage === 'owner-list') return list;
    throw new Error('Ownership rejection must occur before any mutation');
  });
  assert.ok(denied.call('playlist.delete', { playlistId: OWN_PLAYLIST_ID }).error === 'UNSUPPORTED', label);
  assert.ok(denied.requests.every(request => !isMutationRequest(request)), label);
}
// Privacy-redacted numeric identities are valid only through the authenticated
// self-profile route, with matching encrypted ownership on the created catalog.
for (const numericUin of [undefined, 0, '0']) {
  const redactedProfile = structuredClone(profile);
  if (numericUin === undefined) delete redactedProfile.data.creator.uin;
  else redactedProfile.data.creator.uin = numericUin;
  const privacy = create(session, null, 2, (request, state) =>
    ['account', 'liked-profile', 'owner-profile'].includes(state.stage) ? redactedProfile : privateResponse(request, state));
  assert.equal(privacy.call('account.get', {}).accountId, 'enc:' + OWNER_ENCRYPTED_UIN);
  assert.equal(privacy.call('library.likedTracks', { offset: 0, limit: 3 }).items[0].type, 'track');
  assert.deepEqual(privacy.call('library.createdPlaylists', { offset: 0, limit: 3 }).items[0].playlist.editableActions,
    ['update', 'delete', 'addTracks', 'removeTracks']);
  const before = privacy.requests.length;
  assert.equal(privacy.call('playlist.delete', { playlistId: OWN_PLAYLIST_ID }), true);
  assert.equal(privacy.requests.length - before, 3);
}
for (const bad of [null, false, true, {}, [], '', '00', 'o0', -1, 1.5, '654321']) {
  const malformed = structuredClone(profile); malformed.data.creator.uin = bad;
  const rejected = create(session, null, 2, () => malformed);
  assert.deepEqual(rejected.call('account.get', {}), { error: 'INVALID_RESPONSE' });
}
for (const bad of [undefined, '', ' ', 'bad\nidentity', {}, 0]) {
  const malformed = structuredClone(profile); malformed.data.creator.uin = 0; malformed.data.creator.encrypt_uin = bad;
  assert.deepEqual(create(session, null, 2, () => malformed).call('account.get', {}), { error: 'INVALID_RESPONSE' });
}
for (const replacement of ['uin=o654321; qqmusic_key=other-fixture-key', 'uin=o123456; qqmusic_key=rotated-fixture-key']) {
  const movingSession = { ...session };
  const denied = create(movingSession, null, 2, (_, state) => {
    if (state.stage === 'owner-profile') { movingSession.cookie = replacement; return profile; }
    throw new Error('A changed session must not continue ownership verification');
  });
  assert.ok(denied.call('playlist.delete', { playlistId: OWN_PLAYLIST_ID }).error === 'AUTH_EXPIRED');
  assert.equal(denied.requests.length, 1);
}
const wrongDetail = structuredClone(ownPlaylist);
wrongDetail.playlist.data.dirinfo.encrypt_uin = 'another-fixture-owner';
const deniedUpdate = create(session, null, 2, (request, state) => state.stage === 'owned-update-detail' ? wrongDetail : privateResponse(request, state));
assert.ok(deniedUpdate.call('playlist.update', { playlistId: OWN_PLAYLIST_ID, title: 'New title' }).error === 'UNSUPPORTED');
assert.ok(deniedUpdate.requests.every(request => !isMutationRequest(request)));

// Status-only endpoints use an explicit child success code. Result-bearing endpoints also need result=0.
const saveParams = { type: 'artist', id: '0025NhlN2yWrP4', saved: true };
for (const payload of [
  { code: 0, collection: { code: 0 } },
  { code: '0', collection: { code: '0', data: {} } },
  { code: 0, collection: { code: 0, data: { result: 0 } } },
  { code: 0, collection: { code: 0, data: { result: '0' } } },
]) assert.equal(create(session, null, 2, () => payload).call('collection.save', saveParams), true);
for (const value of ['1', '-1', 1, -1]) {
  const result = create(session, null, 2, () => ({ code: 0, collection: { code: 0, data: { result: value } } })).call('collection.save', saveParams);
  assert.ok(result.error === 'UNAVAILABLE', 'A nonzero result cannot confirm a write');
}
for (const value of [null, false, true, {}, [], '', '00', '-0', '0.0', '0e0', 'NaN']) {
  const result = create(session, null, 2, () => ({ code: 0, collection: { code: 0, data: { result: value } } })).call('collection.save', saveParams);
  assert.ok(result.error === 'INVALID_RESPONSE', 'An unknown result cannot confirm a write');
}
for (const payload of [
  { collection: { code: 0, data: {} } },
  { code: 0, collection: {} },
  { code: 0, collection: { data: { result: 0 } } },
  { code: 0, collection: { code: null, data: {} } },
  { code: 0, collection: { code: 'not-a-code', data: {} } },
  { code: 0, collection: { code: false, data: {} } },
  { code: 0, collection: { code: 0, data: { unknown: true } } },
  { code: 0, collection: { code: 0, data: [] } },
  { code: 0, collection: { code: 0, data: null } },
]) assert.ok(create(session, null, 2, () => payload).call('collection.save', saveParams).error === 'INVALID_RESPONSE');
for (const result of [{}, { tid: 0, dirId: 7 }, { tid: OWN_PLAYLIST_ID, dirId: 201 },
  { tid: OWN_PLAYLIST_ID, dirId: true }, { tid: OWN_PLAYLIST_ID, dirId: 7, unknown: true }, 0, '0']) {
  const output = create(session, null, 2, () => ({ code: 0, mutation: { code: 0, data: { result } } }))
    .call('playlist.create', { title: 'Fixture create' });
  assert.ok(output.error === 'INVALID_RESPONSE', 'Create must return its real playlist and editable directory IDs');
}
for (const operation of ['playlist.delete', 'collection.save']) {
  const params = operation === 'playlist.delete' ? { playlistId: OWN_PLAYLIST_ID } : { type: 'album', id: '000LFWfZ3G7QtG', saved: true };
  for (const result of [0, '0']) {
    const valid = create(session, null, 2, (request, state) => state.stage === 'mutation'
      ? { code: 0, [state.key]: { code: 0, data: { result } } } : privateResponse(request, state));
    assert.equal(valid.call(operation, params), true);
  }
  const missing = create(session, null, 2, (request, state) => state.stage === 'mutation'
    ? { code: 0, [state.key]: { code: 0, data: {} } } : privateResponse(request, state));
  assert.ok(missing.call(operation, params).error === 'INVALID_RESPONSE');
}
console.log('QQ ownership and writes: current-session unique directory proof and strict endpoint success schemas passed offline.');

// System targets remain noneditable even when a malformed list repeats their global ID.
const duplicateSystemId = structuredClone(ownCreated);
duplicateSystemId.data.disslist[1].tid = duplicateSystemId.data.disslist[0].tid;
const systemCollision = create(session, null, 2, (_, state) => state.stage === 'owner-profile' ? profile : duplicateSystemId);
assert.ok(systemCollision.call('playlist.delete', { playlistId: '123' }).error === 'UNSUPPORTED');
assert.ok(systemCollision.requests.every(request => !isMutationRequest(request)));

// Small search pages still fetch a supported backend page, then consume only visible positions.
for (const type of ['track', 'playlist', 'album', 'artist']) for (const authenticated of [false, true]) {
  const rows = Array.from({ length: 47 }, (_, index) => type === 'track' ? { ...fixtures.detail.detail.data.track_info, mid: 'Track' + index, title: 'Track ' + index } :
    type === 'playlist' ? { dissid: String(7000000000 + index), dissname: 'Playlist ' + index } :
    type === 'album' ? { albummid: 'Album' + index, name: 'Album ' + index } : { singerMID: 'Artist' + index, singerName: 'Artist ' + index });
  const key = (authenticated ? { track: 'song', playlist: 'songlist', album: 'album', artist: 'singer' } :
    { track: 'item_song', playlist: 'item_songlist', album: 'item_album', artist: 'singer' })[type];
  const pages = create(authenticated ? session : {}, null, 2, request => {
    const payload = requestPayload(request).request, params = payload.param;
    assert.equal(payload.method, authenticated ? 'DoSearchForQQMusicDesktop' : 'DoSearchForQQMusicLite');
    assert.ok(params.num_per_page >= 20);
    assert.match(params.searchid, /^\d+$/);
    assert.equal(request.headers.Cookie, authenticated ? session.cookie : undefined);
    if (authenticated) assert.equal(params.remoteplace, 'yqq.yqq.yqq');
    const start = (params.page_num - 1) * params.num_per_page;
    const list = rows.slice(start, start + params.num_per_page);
    return { code: 0, request: { code: 0, data: { body: { [key]: authenticated ? { list } : list }, meta: { sum: rows.length } } } };
  });
  let cursor; const found = [];
  do {
    const result = pages.call('catalog.search', { query: 'Fixture', type, offset: found.length, limit: 3, cursor });
    assert.ok(!result.error);
    found.push(...result.items.map(value => value[type][{ track: 'trackId', playlist: 'playlistId', album: 'albumId', artist: 'artistId' }[type]]));
    cursor = result.hasMore ? result.nextCursor : undefined;
  } while (cursor);
  assert.equal(found.length, rows.length);
  assert.equal(new Set(found).size, rows.length);
  assert.deepEqual(found, rows.map(value => type === 'track' ? value.mid : type === 'playlist' ? value.dissid : type === 'album' ? value.albummid : value.singerMID));
  const tiny = pages.call('catalog.search', { query: 'Fixture', type, offset: 19, limit: 1 });
  assert.equal(tiny.items.length, 1);
  assert.equal(tiny.nextCursor, '20');
}
console.log('QQ small search pages: supported backend size, cross-page offsets and unique complete results passed offline.');

// A desktop failure/empty gate gets one Lite route, within the same host-hop budget.
for (const desktop of [
  { code: 0, request: { code: 0, data: { body: { song: { list: [] } }, meta: { sum: 0 } } } },
  { code: 0, request: { code: 1000 } },
  { code: 0, request: { code: 2001 } },
]) {
  const fallback = create(session, null, 2, (request, state) => {
    assert.equal(request.headers.Cookie, state.searchTransport === 'desktop' ? session.cookie : undefined);
    return state.searchTransport === 'desktop' ? desktop : fixtures.search;
  });
  assert.equal(fallback.call('catalog.search', { query: 'Fixture', type: 'track', offset: 0, limit: 3 }).items[0].type, 'track');
  assert.equal(fallback.requests.length, 2);
  assert.equal(requestPayload(fallback.requests[1]).request.method, 'DoSearchForQQMusicLite');
}
const failedCorroboration = create(session, null, 2, (_, state) => state.searchTransport === 'desktop' ?
  { code: 0, request: { code: 0, data: { body: { song: { list: [] } }, meta: { sum: 0 } } } } :
  { code: 0, request: { code: 2001 } });
assert.deepEqual(failedCorroboration.call('catalog.search', { query: 'Fixture', type: 'track', offset: 0, limit: 3 }), { error: 'UNAVAILABLE' });
assert.equal(failedCorroboration.requests.length, 2);
const partialBudget = create(session, null, 2, (request, state) => {
  if (state.searchTransport === 'desktop') return { code: 0, request: { code: 1000 } };
  const params = requestPayload(request).request.param;
  const list = Array.from({ length: params.num_per_page }, (_, index) => index === 0 ?
    { ...fixtures.detail.detail.data.track_info, mid: 'Budget' + params.page_num } : {});
  return { code: 0, request: { code: 0, data: { body: { item_song: list }, meta: { sum: 200 } } } };
});
const partialSearch = partialBudget.call('catalog.search', { query: 'Fixture', type: 'track', offset: 0, limit: 4 });
assert.equal(partialBudget.requests.length, 4);
assert.equal(partialSearch.items.length, 3);
assert.equal(partialSearch.hasMore, true);
assert.equal(partialSearch.nextCursor, '60');
console.log('QQ search transports: official authenticated Desktop schemas and bounded anonymous Lite corroboration passed offline.');

// New successful QQ acknowledgement fields must be corroborated, not accepted blindly.
for (const liked of [true, false]) for (const acknowledgement of [
  { result: 0, song_count: 1 }, { accepted: true }, { result: { applied: true } },
]) {
  const verified = create(session, null, 2, (request, state) => {
    if (state.stage === 'mutation') return { code: 0, mutation: { code: 0, data: acknowledgement } };
    if (state.stage === 'like-verified') return { code: 0, liked: { code: 0, data: { m_fan: { [trackId]: liked ? 1 : 0 } } } };
    return privateResponse(request, state);
  });
  assert.equal(verified.call('track.like', { trackId, liked }), true);
  assert.equal(verified.requests.length, 3);
  assert.equal(requestPayload(verified.requests.at(-1)).liked.method, 'IsSongFanByMid');
}
for (const liked of [true, false]) {
  const unchanged = create(session, null, 2, (request, state) => {
    if (state.stage === 'mutation') return { code: 0, mutation: { code: 0, data: { unknownAck: true } } };
    if (state.stage === 'like-verified') return { code: 0, liked: { code: 0, data: { m_fan: { [trackId]: liked ? 0 : 1 } } } };
    return privateResponse(request, state);
  });
  assert.deepEqual(unchanged.call('track.like', { trackId, liked }), { error: 'UNAVAILABLE' });
}
for (const response of [{ m_fan: {} }, { m_fan: { [trackId]: 'unknown' } }, {}]) {
  const malformed = create(session, null, 2, (request, state) => {
    if (state.stage === 'mutation') return { code: 0, mutation: { code: 0, data: { unknownAck: true } } };
    if (state.stage === 'like-verified') return { code: 0, liked: { code: 0, data: response } };
    return privateResponse(request, state);
  });
  assert.deepEqual(malformed.call('track.like', { trackId, liked: true }), { error: 'INVALID_RESPONSE' });
}
console.log('QQ favorite acknowledgements: ambiguous successful writes require an exact canonical readback.');

// Batch favorite reads publish only complete, requested canonical states.
const favoriteIds = [trackId, 'BatchSong2'];
const batchLikes = create(session, null, 2, request => {
  assert.deepEqual(requestPayload(request).liked.param.v_songMid, favoriteIds);
  return { code: 0, liked: { code: 0, data: { m_fan: { [trackId]: '1', BatchSong2: 0 } } } };
});
assert.deepEqual(batchLikes.call('track.liked', { trackIds: favoriteIds }), { items: [{ trackId, liked: true }, { trackId: 'BatchSong2', liked: false }] });
for (const flags of [{ [trackId]: 1 }, { [trackId]: 1, BatchSong2: 'unknown' }, { [trackId]: 1, OtherSong: 0 }]) {
  const badBatch = create(session, null, 2, () => ({ code: 0, liked: { code: 0, data: { m_fan: flags } } }));
  assert.deepEqual(badBatch.call('track.liked', { trackIds: favoriteIds }), { error: 'INVALID_RESPONSE' });
}
for (const options of [{ privacy: true }, { privacy: 'false' }, { type: 'VIDEO' }, { type: 'SHARED' }]) {
  const unsupported = create(session, null, 2);
  assert.deepEqual(unsupported.call('playlist.create', { title: 'Fixture', ...options }), { error: 'UNSUPPORTED' });
  assert.equal(unsupported.requests.length, 0);
}
console.log('QQ favorite batch reads and playlist privacy: complete states and unsupported options enforced offline.');

// Web authentication publishes only verified protocol credentials at the final transition.
const loginCall = (client, action, parameters = {}) => client.call('feature.invoke', { feature: 'login', action, parameters });
const webCookies = { uin: 'o123456', qqmusic_key: 'web-fixture-key' };
function completeWeb(client, start, cookies = webCookies, effect = null) {
  return loginCall(client, 'webLogin', { $continuation: {
    state: start.continuation, token: 'host-owned-token',
    effect: effect || { ok: true, result: { closed: true, cookies, cookie: 'untrusted=not-used' } }
  } });
}
const webConfig = { ...session };
const web = create(webConfig, null, 2, (request, state) => state.stage === 'web-login-profile' || state.stage === 'account' ? profile : fixtures.detail);
assert.deepEqual(loginCall(web, 'sessionState'), { authenticated: true, kind: 'web' });
const start = loginCall(web, 'webLogin', { url: 'https://untrusted.example/' });
assert.equal(start.hostEffect.type, 'web.auth');
const page = start.hostEffect.parameters;
const oauth = new URL(page.url);
assert.equal(oauth.origin, 'https://graph.qq.com');
assert.equal(oauth.pathname, '/oauth2.0/show');
assert.equal(oauth.searchParams.get('which'), 'Login');
assert.equal(oauth.searchParams.get('client_id'), '100497308');
assert.equal(oauth.searchParams.get('force_qr'), '1');
assert.equal(oauth.searchParams.get('style'), '40');
assert.equal(new URL(oauth.searchParams.get('redirect_uri')).origin, 'https://y.qq.com');
assert.deepEqual(page.cookieHosts, ['y.qq.com', 'i2.y.qq.com', 'graph.qq.com', 'connect.qq.com', 'xui.ptlogin2.qq.com', 'ssl.ptlogin2.qq.com', 'ui.ptlogin2.qq.com', 'ssl.ptlogin2.graph.qq.com', 'ptlogin2.qq.com']);
assert.ok(page.cookieNames.length <= 32 && page.cookieNames.includes('qqmusic_key') && page.cookieNames.includes('uin'));
assert.ok(page.cookieNames.every(name => !name.startsWith('pt_')));
assert.ok(page.allowedHosts.every(host => manifest.permissions.network.includes(host)));
assert.deepEqual(page.allowedHosts, ['*.qq.com', '*.gtimg.com', '*.cdn-go.cn', '*.qpic.cn', '*.idqqimg.cn']);
assert.ok(['connect.qq.com', 'jsapi.qq.com', 'open.mobile.qq.com'].every(host =>
  page.allowedHosts.some(grant => grant === host || grant.startsWith('*.') && host.endsWith(grant.slice(1)))));
assert.ok(page.cookieHosts.every(host => page.allowedHosts.some(grant =>
  grant === host || grant.startsWith('*.') && host.endsWith(grant.slice(1)))));
assert.deepEqual(web.storageSnapshot(), {});
const signedIn = completeWeb(web, start, { ...webCookies, unrelated_cookie: 'must-not-be-exported' });
assert.deepEqual(signedIn, { authenticated: true, accountId: 'enc:' + OWNER_ENCRYPTED_UIN, displayName: 'Fixture account', avatarUrl: 'https://q.qlogo.cn/fixture' });
assert.equal(web.requests.length, 1);
assert.equal(new URL(web.requests[0].url).searchParams.get('userid'), '0');
assert.equal(web.requests[0].headers.Cookie, 'uin=o123456; qqmusic_key=web-fixture-key');
assert.deepEqual(Object.keys(web.storageSnapshot()).sort(), ['cookie', 'guid', 'manualCookieTag']);
assert.equal(web.storageSnapshot().cookie, 'uin=o123456; qqmusic_key=web-fixture-key');
assert.match(web.storageSnapshot().manualCookieTag, /^[a-f0-9]{40}$/);
assert.equal(web.call('catalog.track', { trackId }).trackId, trackId);
assert.equal(web.storageSnapshot().cookie, 'uin=o123456; qqmusic_key=web-fixture-key');
assert.deepEqual(web.call('account.get', {}), { accountId: 'enc:' + OWNER_ENCRYPTED_UIN, displayName: 'Fixture account', avatarUrl: 'https://q.qlogo.cn/fixture' });
assert.equal(loginCall(web, 'logout'), true);
assert.deepEqual(loginCall(web, 'sessionState'), { authenticated: false, kind: null });
assert.equal(web.call('account.get', {}), null);
assert.deepEqual(web.call('playback.resolve', { trackId }), { error: 'AUTH_REQUIRED' });
webConfig.cookie = 'uin=o123456; qqmusic_key=renewed-manual-key';
assert.deepEqual(loginCall(web, 'sessionState'), { authenticated: true, kind: 'web' });
web.call('account.get', {});
assert.equal(web.requests.at(-1).headers.Cookie, webConfig.cookie);

for (const [cookies, expected] of [
  [{}, 'AUTH_REQUIRED'], [{ qqmusic_key: 'key-only' }, 'AUTH_REQUIRED'],
  [{ ...webCookies, qqmusic_key: 'injected; other=value' }, 'INVALID_RESPONSE'],
  [{ ...webCookies, qqmusic_key: 'injected\r\nHeader: value' }, 'INVALID_RESPONSE'],
  [{ ...webCookies, qqmusic_key: 'x'.repeat(8193) }, 'INVALID_RESPONSE'],
]) {
  const rejected = create({}, null, 2, () => { throw new Error('Rejected web credentials must not make a request'); });
  assert.deepEqual(completeWeb(rejected, loginCall(rejected, 'webLogin'), cookies), { error: expected });
  assert.deepEqual(rejected.storageSnapshot(), {});
}
for (const response of [{ code: 1000 }, { ...profile, data: { creator: { ...profile.data.creator, uin: '999999' } } }]) {
  const rejected = create({}, null, 2, () => response);
  assert.ok(completeWeb(rejected, loginCall(rejected, 'webLogin')).error);
  assert.deepEqual(rejected.storageSnapshot(), {});
}
const cancelledLogin = create({}, null, 2);
assert.deepEqual(completeWeb(cancelledLogin, loginCall(cancelledLogin, 'webLogin'), {}, { ok: false, code: 'CANCELLED' }), { error: 'CANCELLED' });
assert.deepEqual(cancelledLogin.storageSnapshot(), {});
const changingConfig = { ...session }, staleLogin = create(changingConfig, null, 2);
const staleStart = loginCall(staleLogin, 'webLogin');
changingConfig.cookie = 'uin=o654321; qqmusic_key=another-account';
assert.deepEqual(completeWeb(staleLogin, staleStart), { error: 'AUTH_EXPIRED' });
assert.equal(staleLogin.requests.length, 0);
const expiredLogin = create({}, null, 2), expiredStart = loginCall(expiredLogin, 'webLogin');
expiredLogin.advanceClock(30 * 60 * 1000 + 1);
assert.deepEqual(completeWeb(expiredLogin, expiredStart), { error: 'AUTH_EXPIRED' });
assert.equal(expiredLogin.requests.length, 0);
assert.deepEqual(expiredLogin.storageSnapshot(), {});
const delayedEmptyLogin = create({}, null, 2), delayedEmptyStart = loginCall(delayedEmptyLogin, 'webLogin');
delayedEmptyLogin.advanceClock(10 * 60 * 1000);
assert.deepEqual(completeWeb(delayedEmptyLogin, delayedEmptyStart, {}), { error: 'AUTH_REQUIRED' });
assert.equal(delayedEmptyLogin.requests.length, 0);
assert.deepEqual(delayedEmptyLogin.storageSnapshot(), {});
const delayedVerifiedLogin = create({}, null, 2, (_request, state) => {
  assert.equal(state.stage, 'web-login-profile');
  return profile;
});
const delayedVerifiedStart = loginCall(delayedVerifiedLogin, 'webLogin');
delayedVerifiedLogin.advanceClock(10 * 60 * 1000);
assert.equal(completeWeb(delayedVerifiedLogin, delayedVerifiedStart).authenticated, true);
assert.equal(delayedVerifiedLogin.requests.length, 1);
assert.equal(delayedVerifiedLogin.storageSnapshot().cookie, 'uin=o123456; qqmusic_key=web-fixture-key');
const unboundedLogin = create({}, null, 2), unboundedStart = loginCall(unboundedLogin, 'webLogin');
unboundedStart.continuation.expiresAt += 30 * 60 * 1000;
assert.deepEqual(completeWeb(unboundedLogin, unboundedStart), { error: 'AUTH_EXPIRED' });
assert.equal(unboundedLogin.requests.length, 0);
assert.deepEqual(unboundedLogin.storageSnapshot(), {});
assert.deepEqual(manifest.features.login, ['webLogin', 'sessionState', 'logout']);
assert.deepEqual(manifest.sessionKeys, ['cookie', 'manualCookieTag']);
assert.deepEqual(manifest.sessionCookieNames.cookie, ['uin', 'p_uin', 'wxuin', 'wxopenid', 'qqmusic_uin', 'qqmusic_key', 'qm_keyst', 'p_skey', 'skey', 'p_lskey', 'lskey', 'login_type', 'qqmusic_guid']);
assert.deepEqual(manifest.permissions.effects, ['web.auth']);
assert.deepEqual(manifest.featureRoutes, ['account/login']);
assert.deepEqual(manifest.concurrentReadFeatures, { login: ['sessionState'] });
console.log('QQ web authentication: fixed OAuth/cookie scope, verified final commit, protocol-only persistence, logout, manual renewal, cancellation and stale-session rejection passed offline.');
