import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const fixtures = Object.fromEntries(['search', 'detail', 'lyrics'].map(name => [name,
  JSON.parse(fs.readFileSync(path.join(root, `fixtures/captured-${name}.json`), 'utf8'))]));
const trackId = fixtures.detail.detail.data.track_info.mid;
const session = { cookie: 'uin=o123456; qqmusic_key=fixture%40key', uin: '' };

function create(config = {}, playback = null, apiVersion = 1, respond = null) {
  const isolated = vm.createContext({});
  vm.runInContext(source, isolated, { timeout: 1000 });
  const requests = [];
  let storage = {};
  return {
    requests,
    call(operation, params) {
      isolated.operation = operation;
      isolated.params = params;
      isolated.context = { apiVersion, config, storage };
      let result = JSON.parse(vm.runInContext('JSON.stringify(sourcePlugin[operation](params, context))', isolated, { timeout: 1000 }));
      for (let hop = 0; result && result.request; hop++) {
        assert.ok(hop < 4);
        requests.push(result.request);
        assert.ok(/^https:\/\/(?:u|c)\.y\.qq\.com\//.test(result.request.url));
        const stage = result.state.stage;
        const fixture = respond ? respond(result.request, result.state) : stage === 'search' ? fixtures.search : stage === 'lyrics' ? fixtures.lyrics : stage === 'playback' ? playback : fixtures.detail;
        assert.ok(fixture, `Unexpected stage: ${stage}`);
        isolated.response = { status: 200, body: JSON.stringify(fixture) };
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
const payload = JSON.parse(permitted.requests.at(-1).body);
assert.equal(payload.playback.module, 'music.vkey.GetEVkey');
assert.equal(payload.playback.method, 'GetUrl');
assert.equal(payload.playback.param.uin, '123456');
assert.equal(payload.comm.uin, 123456);
assert.equal(payload.comm.g_tk, payload.comm.g_tk_new_20200303);
assert.equal(payload.comm.g_tk, 510355573);
assert.ok(!Object.hasOwn(payload.comm, 'authst'));
assert.ok(!Object.hasOwn(payload.playback.param, 'filename'));

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
assert.equal(JSON.parse(longUin.requests.at(-1).body).comm.uin, '123456789012345678');
const cookieIdentity = playback({ midurlinfo: [] }, { cookie: 'uin=o%30%30%30%31%32%33%34%35%36; qqmusic_key=fixture%2540key', uin: '999999' });
cookieIdentity.call('playback.resolve', { trackId });
const cookiePayload = JSON.parse(cookieIdentity.requests.at(-1).body);
assert.equal(cookiePayload.comm.uin, 123456);
assert.equal(cookiePayload.comm.g_tk, 510355573);
const wechat = playback({ midurlinfo: [] }, { cookie: 'uin=o123456; wxopenid=fixture-openid; wxuin=123456789012345678; qm_keyst=fixture-wechat-key' });
wechat.call('playback.resolve', { trackId });
const wechatPayload = JSON.parse(wechat.requests.at(-1).body);
assert.equal(wechatPayload.comm.uin, '123456789012345678');
assert.equal(wechatPayload.playback.param.uin, '123456789012345678');
assert.equal(wechatPayload.comm.g_tk, 5381);
const aacFile = `C400${fixtures.detail.detail.data.track_info.file.media_mid}.m4a`;
const aac = playback({ midurlinfo: [{ songmid: trackId, filename: aacFile, purl: aacFile }] }).call('playback.resolve', { trackId });
assert.equal(aac.mimeType, 'audio/mp4');
assert.equal(aac.quality, 'standard');
assert.ok(!Object.hasOwn(aac, 'contentLength'));
const injected = create({ cookie: session.cookie + '\r\nX-Injected: yes' });
assert.deepEqual(injected.call('playback.resolve', { trackId }), { error: 'INVALID_RESPONSE' });
assert.equal(injected.requests.length, 0);
assert.deepEqual(manifest.permissions.network, ['u.y.qq.com', 'c.y.qq.com', 'y.gtimg.cn', 'music-file.y.qq.com', 'p.qpic.cn', 'qpic.y.qq.com', 'pic6.y.qq.com', 'thirdqq.qlogo.cn', 'q.qlogo.cn', 'ws6.stream.qqmusic.qq.com']);
assert.ok(manifest.config.every(field => !field.required));

// API2 exercises captured public metadata and synthetic private-account responses.
// This runner never makes network calls or writes to a QQ account.
const captured = name => JSON.parse(fs.readFileSync(path.join(root, `fixtures/captured-${name}.json`), 'utf8'));
const publicFixtures = Object.fromEntries(['feed', 'category', 'playlist', 'chart', 'album', 'album-tracks', 'artist', 'artist-tracks', 'artist-albums', 'search-artist', 'search-album', 'search-playlist'].map(name => [name, captured(name)]));
function publicResponse(request, state) {
  if (state.stage === 'search') return state.type === 'track' ? fixtures.search : publicFixtures['search-' + state.type];
  if (state.stage === 'feed') {
    const keys = Object.keys(JSON.parse(request.body)).filter(key => key !== 'comm');
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
assert.deepEqual(home.sections.map(section => section.id), ['recommend', 'songs', 'albums', 'charts']);
assert.ok(home.sections.every(section => section.items.length > 0));
const recommended = home.sections[0].items[0].playlist;
assert.equal(recommended.playlistId, '8044204090');
assert.equal(catalog.call('playlist.get', { playlistId: recommended.playlistId }).title, recommended.title);
const playlistTracks = catalog.call('playlist.tracks', { playlistId: recommended.playlistId, offset: 0, limit: 3 });
assert.equal(playlistTracks.items.length, 3);
assert.equal(playlistTracks.items[0].trackId, '002eDlpu4U223F');
assert.equal(playlistTracks.hasMore, true);
const filteredPageFixture = structuredClone(publicFixtures.playlist);
filteredPageFixture.playlist.data.songlist[1].mid = '';
const filteredPage = create({}, null, 2, () => filteredPageFixture).call('playlist.tracks', { playlistId: recommended.playlistId, offset: 0, limit: 3 });
assert.equal(filteredPage.items.length, 2);
assert.equal(filteredPage.nextCursor, '3');
const chart = home.sections.find(section => section.id === 'charts').items[0].playlist;
assert.equal(chart.playlistId, 'chart:62');
assert.equal(catalog.call('playlist.get', { playlistId: chart.playlistId }).playlistId, chart.playlistId);
assert.equal(catalog.call('playlist.tracks', { playlistId: chart.playlistId, offset: 0, limit: 3 }).items.length, 3);
const album = home.sections.find(section => section.id === 'albums').items[0].album;
assert.equal(catalog.call('album.get', { albumId: album.albumId }).albumId, album.albumId);
assert.equal(catalog.call('album.tracks', { albumId: album.albumId, offset: 0, limit: 3 }).items.length, 2);
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
const profile = { code: 0, data: { creator: { uin: '123456', nick: 'Fixture account', headpic: 'https://q.qlogo.cn/fixture' }, mymusic: [{ type: 1, id: '99887766', num0: 3 }] } };
const ownPlaylist = structuredClone(publicFixtures.playlist);
ownPlaylist.playlist.data.dirinfo.owndir = 1;
ownPlaylist.playlist.data.dirinfo.dirid = 7;
ownPlaylist.playlist.data.dirinfo.desc = 'Keep this description';
const requestsFor = [];
function privateResponse(request, state) {
  requestsFor.push({ request, state });
  const envelope = data => ({ code: 0, [state.key]: { code: 0, data } });
  if (state.stage === 'account' || state.stage === 'liked-profile') return profile;
  if (state.stage === 'liked-tracks') {
    assert.equal(JSON.parse(request.body).playlist.param.disstid, 99887766);
    return publicFixtures.playlist;
  }
  if (state.stage === 'library.createdPlaylists') return { code: 0, data: { totoal: 3, disslist: [{ tid: 123, dirid: 201, diss_name: 'Favorites', song_cnt: 3 }, { tid: 8044204090, dirid: 7, diss_name: 'My playlist', song_cnt: 3 }, { tid: 456, dirid: 8, diss_name: 'Next playlist', song_cnt: 0 }] } };
  if (state.stage === 'library.savedPlaylists') return { code: 0, data: { totaldiss: 2, cdlist: [{ dissid: '8044204090', dissname: 'Saved one', songnum: 3 }, { dissid: '8870221359', dissname: 'Saved two', songnum: 1 }] } };
  if (state.stage === 'library.savedAlbums') return { code: 0, data: { totalalbum: 1, albumlist: [{ albummid: '000LFWfZ3G7QtG', albumname: 'Saved album', singer: '徐艺洋' }] } };
  if (state.stage === 'library.followedArtists') return envelope({ List: [{ MID: '0025NhlN2yWrP4', Name: '周杰伦', AvatarUrl: 'https://y.gtimg.cn/fixture' }], HasMore: false });
  if (state.stage === 'saved') return envelope(state.type === 'artist' ? { map_singer_status: { [state.id]: 1 } } : { m_fan: { [state.id]: 1 } });
  if (state.stage === 'created') return envelope({ result: { tid: 1122334455, dirId: 9 } });
  if (state.stage === 'playlist-own') return ownPlaylist;
  if (state.stage === 'playlist-song-details') return { code: 0, song0: fixtures.detail.detail };
  if (state.stage === 'mutation') return envelope({ result: 0 });
  if (state.stage === 'like-detail') return fixtures.detail;
  throw new Error(`Unhandled private fixture stage: ${state.stage}`);
}
const personal = create(session, null, 2, privateResponse);
assert.deepEqual(personal.call('account.get', {}), { accountId: '123456', displayName: 'Fixture account', avatarUrl: 'https://q.qlogo.cn/fixture' });
const profileRequest = new URL(personal.requests.at(-1).url);
assert.equal(profileRequest.hostname, 'c.y.qq.com');
assert.equal(profileRequest.pathname, '/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
assert.equal(profileRequest.searchParams.get('userid'), '0');
assert.equal(profileRequest.searchParams.get('loginUin'), '123456');
assert.equal(profileRequest.searchParams.get('g_tk'), '510355573');
assert.equal(personal.call('library.likedTracks', { offset: 0, limit: 3 }).items[0].type, 'track');
const created = personal.call('library.createdPlaylists', { offset: 0, limit: 2 });
assert.equal(created.items.length, 2);
assert.equal(created.items[0].playlist.playlistId, '8044204090');
assert.deepEqual(created.items[0].playlist.editableActions, ['update', 'delete', 'addTracks', 'removeTracks']);
assert.equal(created.hasMore, false);
assert.equal(created.nextCursor, undefined);
// Server positions include up to nine system directories, independently of visible items.
const rawDirectories = [...Array.from({ length: 9 }, (_, index) => ({ tid: 2000000000 + index, dirid: 201 + index, diss_name: 'System directory' })),
  ...Array.from({ length: 5 }, (_, index) => ({ tid: 1000000000 + index, dirid: 1 + index, diss_name: 'Custom ' + index }))];
const directoryPages = create(session, null, 2, request => {
  const url = new URL(request.url);
  const start = Number(url.searchParams.get('sin'));
  const size = Number(url.searchParams.get('size'));
  assert.ok(size >= 30);
  return { code: 0, data: { totoal: rawDirectories.length, disslist: rawDirectories.slice(start, start + size) } };
});
const directoryFirst = directoryPages.call('library.createdPlaylists', { offset: 0, limit: 3 });
assert.equal(directoryFirst.items.length, 3);
assert.equal(directoryFirst.nextCursor, '12');
const directoryNext = directoryPages.call('library.createdPlaylists', { offset: directoryFirst.items.length, limit: 3, cursor: directoryFirst.nextCursor });
assert.equal(directoryNext.items.length, 2);
assert.equal(directoryNext.hasMore, false);
assert.equal(new URL(directoryPages.requests[1].url).searchParams.get('sin'), '12');
assert.deepEqual([...directoryFirst.items, ...directoryNext.items].map(value => value.playlist.playlistId),
  Array.from({ length: 5 }, (_, index) => String(1000000000 + index)));
const cappedDirectories = [...rawDirectories.slice(0, 9), ...Array.from({ length: 35 }, (_, index) =>
  ({ tid: 3000000000 + index, dirid: 1 + index, diss_name: 'Capped custom ' + index }))];
const cappedPages = create(session, null, 2, request => {
  const start = Number(new URL(request.url).searchParams.get('sin'));
  return { code: 0, data: { totoal: cappedDirectories.length, disslist: cappedDirectories.slice(start, start + 30) } };
});
const cappedFirst = cappedPages.call('library.createdPlaylists', { offset: 0, limit: 30 });
assert.equal(cappedFirst.items.length, 30);
assert.equal(cappedFirst.nextCursor, '39');
assert.equal(cappedPages.requests.length, 2);
const cappedNext = cappedPages.call('library.createdPlaylists', { offset: 30, limit: 30, cursor: cappedFirst.nextCursor });
assert.equal(cappedNext.items.length, 5);
assert.equal(cappedNext.hasMore, false);
assert.deepEqual([...cappedFirst.items, ...cappedNext.items].map(value => value.playlist.playlistId),
  Array.from({ length: 35 }, (_, index) => String(3000000000 + index)));
const systemOnly = create(session, null, 2, () => ({ code: 0, data: { disslist: rawDirectories.slice(0, 9) } }));
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
let last = JSON.parse(personal.requests.at(-1).body).mutation;
assert.equal(last.method, 'AddSonglist');
assert.equal(last.param.dirId, 201);
assert.deepEqual(last.param.v_songInfo, [{ songType: 0, songId: 97773 }]);
assert.equal(personal.call('track.like', { trackId, liked: false }), true);
assert.equal(JSON.parse(personal.requests.at(-1).body).mutation.method, 'DelSonglist');
assert.equal(personal.call('playlist.create', { title: 'A new playlist', description: 'Fixture' }).playlistId, '1122334455');
last = JSON.parse(personal.requests.at(-1).body).mutation;
assert.equal(last.module, 'music.musicasset.PlaylistBaseWrite');
assert.equal(last.method, 'AddPlaylist');
assert.equal(last.param.dirName, 'A new playlist');
assert.equal(personal.call('playlist.update', { playlistId: '8044204090', title: 'New title' }), true);
last = JSON.parse(personal.requests.at(-1).body).mutation;
assert.equal(last.method, 'EditPlaylist');
assert.equal(last.param.dirId, 7);
assert.notEqual(last.param.dirId, 8044204090);
assert.equal(last.param.dirNewDesc, 'Keep this description');
assert.equal(last.param.mask, 95);
for (const [operation, method] of [['playlist.addTracks', 'AddSonglist'], ['playlist.removeTracks', 'DelSonglist']]) {
  assert.equal(personal.call(operation, { playlistId: '8044204090', trackIds: [trackId] }), true);
  last = JSON.parse(personal.requests.at(-1).body).mutation;
  assert.equal(last.method, method);
  assert.equal(last.param.dirId, 7);
  assert.deepEqual(last.param.v_songInfo, [{ songType: 0, songId: 97773 }]);
}
assert.equal(personal.call('playlist.delete', { playlistId: '8044204090' }), true);
assert.equal(JSON.parse(personal.requests.at(-1).body).mutation.param.dirId, 7);
const otherOwner = create(session, null, 2, () => publicFixtures.playlist);
assert.deepEqual(otherOwner.call('playlist.delete', { playlistId: '8044204090' }), { error: 'UNSUPPORTED' });
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
