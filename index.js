/* Experimental adapter for QQ Music's public website contract, not its partner OpenAPI. */
(function () {
  'use strict';
  const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  const AUDIO_HOST = 'ws6.stream.qqmusic.qq.com';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

  function failure(code) { return { error: code }; }
  function cookieText(context) {
    return String(context.config.cookie || '').trim().replace(/^Cookie:\s*/i, '');
  }
  function cookieFields(context) {
    const fields = Object.create(null);
    cookieText(context).split(';').forEach(function (part) {
      const position = part.indexOf('=');
      if (position > 0) fields[part.slice(0, position).trim()] = part.slice(position + 1).trim();
    });
    return fields;
  }
  function decodedCookie(value) {
    let decoded = String(value || '');
    for (let attempt = 0; attempt < 8; attempt++) {
      let next;
      try { next = decodeURIComponent(decoded); } catch (_) { return decoded; }
      if (next === decoded) return decoded;
      decoded = next;
    }
    return decoded;
  }
  function hashToken(value) {
    value = decodedCookie(value);
    let hash = 5381;
    for (let index = 0; index < value.length; index++) hash += (hash << 5) + value.charCodeAt(index);
    return hash & 0x7fffffff;
  }
  function account(context) {
    const fields = cookieFields(context);
    const cookieUin = (fields.wxopenid ? fields.wxuin : fields.uin) || fields.p_uin || fields.qqmusic_uin;
    const raw = decodedCookie(cookieUin || context.config.uin).trim().replace(/^o/, '');
    const uin = raw.length < 14 ? raw.replace(/^0+(?=\d)/, '') : raw;
    return {
      uin: /^\d+$/.test(uin) ? uin : '0',
      present: cookieText(context).length > 0,
      hasKey: Boolean(fields.qqmusic_key || fields.qm_keyst || fields.p_lskey || fields.p_skey || fields.skey),
      csrf: hashToken(fields.skey || fields.qqmusic_key),
      csrfNew: hashToken(fields.qqmusic_key || fields.p_skey || fields.skey || fields.p_lskey || fields.lskey)
    };
  }
  function guid(context) {
    return /^\d{8,16}$/.test(context.storage.guid || '') ? context.storage.guid : String(Math.floor(1000000000 + Math.random() * 8999999999));
  }
  function webComm(context) {
    const login = account(context);
    return {
      cv: 4747474, ct: 24, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0,
      platform: 'yqq.json', needNewCode: 1, uin: login.uin.length < 14 ? Number(login.uin) : login.uin,
      g_tk: login.csrf, g_tk_new_20200303: login.csrfNew
    };
  }
  function request(key, module, method, param, state, context, lite) {
    if (state.error) return failure(state.error);
    const cookie = cookieText(context);
    if (/[\r\n\u0000]/.test(cookie)) return failure('INVALID_RESPONSE');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA };
    if (cookie) headers.Cookie = cookie;
    const body = { comm: lite ? { ct: 11, cv: '1003006', v: '1003006', os_ver: '15', phonetype: '24122RKC7C', tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI', udid: '0' } : webComm(context) };
    body[key] = { module: module, method: method, param: param };
    state.guid = state.guid || guid(context);
    state.key = key;
    return { request: { url: API, method: 'POST', headers: headers, body: JSON.stringify(body) }, state: state };
  }
  function mid(value) { return typeof value === 'string' && /^[A-Za-z0-9]{1,80}$/.test(value); }
  function detail(trackId, stage, context, state) {
    if (!mid(trackId)) return failure('NOT_FOUND');
    return request('detail', 'music.pf_song_detail_svr', 'get_song_detail_yqq', { song_mid: trackId },
      Object.assign({}, state, { stage: stage, trackId: trackId }), context, false);
  }
  function text(value) {
    return String(value || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  function track(song, context) {
    if (!song || !mid(song.mid) || !(song.title || song.name)) return null;
    const album = song.album || {};
    const albumMid = String(album.mid || '');
    const result = {
      trackId: song.mid,
      title: text(song.title || song.name),
      artists: (song.singer || []).map(function (singer) { return text(singer.name || singer.title); }).filter(Boolean),
      album: text(album.title || album.name),
      durationMs: Math.max(0, Number(song.interval) || 0) * 1000,
      artworkUrl: mid(albumMid) ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : '',
      version: text(song.subtitle),
      explicit: song.explicit === true
    };
    if (Number((context || {}).apiVersion) >= 2) {
      result.artists = (song.singer || []).map(function (value) { const artist = { name: text(value.name || value.title) }; if (mid(value.mid)) artist.artistId = value.mid; return artist; }).filter(function (value) { return value.name; });
      result.album = { title: text(album.title || album.name) };
      if (mid(albumMid)) result.album.albumId = albumMid;
    }
    return result;
  }
  function finish(result, state) { return { result: result, storage: { guid: state.guid } }; }
  function authError(context) { return failure(account(context).present ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED'); }
  function readResponse(response, key, context, allowEmpty) {
    if (response.status === 401 || response.status === 403) return authError(context);
    if (response.status !== 200) return failure('NETWORK');
    let payload;
    try { payload = JSON.parse(response.body); } catch (_) { return failure('INVALID_RESPONSE'); }
    if (key === '@batch') {
      if (Number(payload.code)) return [1000, 1004, 101010, 104009].indexOf(Number(payload.code)) >= 0 ? authError(context) : failure('UNAVAILABLE');
      return payload;
    }
    const node = key === '@cgi' ? payload : payload[key];
    const code = Number(payload.code) || (node && Number(node.code)) || 0;
    if ([1000, 1004, 101010, 104009, 80030, 80050].indexOf(code) >= 0) return authError(context);
    if (key === '@cgi' && code === -1 && Number(payload.subcode) === -2) return authError(context);
    if (code !== 0) return failure(code === 404 ? 'NOT_FOUND' : 'UNAVAILABLE');
    if (!node || (!allowEmpty && (!node.data || typeof node.data !== 'object'))) return failure('INVALID_RESPONSE');
    return node.data || {};
  }
  function decodeBase64(value) {
    if (!value) return '';
    if (value[0] === '[' || value[0] === '<') return value;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0, count = 0, escaped = '';
    const input = String(value).replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) return '';
    for (let index = 0; index < input.length && input[index] !== '='; index++) {
      bits = (bits << 6) | alphabet.indexOf(input[index]);
      count += 6;
      if (count >= 8) {
        count -= 8;
        escaped += '%' + ((bits >> count) & 255).toString(16).padStart(2, '0');
      }
    }
    try { return decodeURIComponent(escaped); } catch (_) { return ''; }
  }
  function resource(data, state, context) {
    if (data.retcode !== undefined && Number(data.retcode) !== 0) return Number(data.retcode) === 104009 ? authError(context) : failure('UNAVAILABLE');
    const item = (data.midurlinfo || []).find(function (entry) { return entry.songmid === state.trackId; });
    if (!item || !item.purl) return Number(data.retcode) === 104009 ? authError(context) : failure('UNAVAILABLE');
    if (item.result !== undefined && Number(item.result) !== 0) return failure('UNAVAILABLE');
    const actualFilename = decodedCookie(String(item.purl).split(/[?#]/)[0].split('/').pop());
    const filename = String(item.filename || actualFilename);
    // A trial segment must never replace a full recording in automatic fallback.
    if (/^RS\d\d/i.test(filename) || /^RS\d\d/i.test(actualFilename) || item.is_trial || item.isTry) return failure('UNAVAILABLE');
    if (!/^[A-Za-z0-9_.-]+$/.test(actualFilename) || filename !== actualFilename) return failure('INVALID_RESPONSE');
    let quality, mimeType, sizeKey;
    if (/^M500.*\.mp3$/i.test(filename)) { quality = 'standard'; mimeType = 'audio/mpeg'; sizeKey = 'size_128mp3'; }
    else if (/^M800.*\.mp3$/i.test(filename)) { quality = 'exhigh'; mimeType = 'audio/mpeg'; sizeKey = 'size_320mp3'; }
    else if (/^C400.*\.m4a$/i.test(filename) || /^C200.*\.m4a$/i.test(filename)) { quality = 'standard'; mimeType = 'audio/mp4'; }
    else if (/^F000.*\.flac$/i.test(filename)) { quality = 'lossless'; mimeType = 'audio/flac'; sizeKey = 'size_flac'; }
    else return failure('INVALID_RESPONSE');
    let uri = String(item.purl);
    if (/^https?:\/\//i.test(uri)) {
      if (!new RegExp('^https?://' + AUDIO_HOST.replace(/\./g, '\\.') + '(?:/|$)', 'i').test(uri)) return failure('UNSUPPORTED');
      uri = uri.replace(/^http:/i, 'https:');
    } else {
      if (/^(?:\/\/|[a-z]+:)/i.test(uri)) return failure('INVALID_RESPONSE');
      const supplied = [].concat(data.thirdip || [], data.sip || []).filter(function (base) { return typeof base === 'string' && /^https?:\/\//i.test(base); });
      const allowed = supplied.find(function (base) { return new RegExp('^https?://' + AUDIO_HOST.replace(/\./g, '\\.') + '(?:/|$)', 'i').test(base); });
      if (supplied.length && !allowed) return failure('UNSUPPORTED');
      const base = allowed ? allowed.replace(/^http:/i, 'https:').replace(/\/$/, '') : 'https://' + AUDIO_HOST;
      uri = base + '/' + uri.replace(/^\//, '');
    }
    const seconds = Number(data.expiration);
    const mediaMid = String(state.file.media_mid || '');
    const sourceSize = sizeKey && mid(mediaMid) && filename.slice(4, filename.lastIndexOf('.')) === mediaMid ? Number(state.file[sizeKey]) : 0;
    const resource = {
      uri: uri, quality: quality, mimeType: mimeType,
      headers: { Referer: 'https://y.qq.com/', 'User-Agent': UA },
      expiresAtMs: Date.now() + (seconds > 0 ? Math.max(1, seconds - 30) : 120) * 1000,
      contentId: filename + ':' + (sourceSize > 0 ? sourceSize : ''), cachePolicy: 'NO_STORE'
    };
    if (Number.isFinite(sourceSize) && sourceSize > 0) resource.contentLength = sourceSize;
    return finish(resource, state);
  }

  const IMAGE_HOSTS = ['y.gtimg.cn', 'music-file.y.qq.com', 'p.qpic.cn', 'qpic.y.qq.com', 'pic6.y.qq.com', 'thirdqq.qlogo.cn', 'q.qlogo.cn'];
  const EDIT_ACTIONS = ['update', 'delete', 'addTracks', 'removeTracks'];
  function editableDirectory(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 && !(id >= 201 && id <= 209); }
  function image(value) {
    const url = String(value || '').replace(/^\/\//, 'https://').replace(/^http:/i, 'https:');
    const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url);
    return match && IMAGE_HOSTS.indexOf(match[1].toLowerCase()) >= 0 ? url : '';
  }
  function photo(kind, id) {
    return /^[A-Za-z0-9_]{1,100}$/.test(id || '') ? 'https://y.gtimg.cn/music/photo_new/' + kind + 'R300x300M000' + id + '.jpg' : '';
  }
  function page(params) {
    const hasCursor = params.cursor !== undefined && params.cursor !== null;
    if (hasCursor && (typeof params.cursor !== 'string' || !/^\d{1,16}$/.test(params.cursor))) return failure('INVALID_RESPONSE');
    const offset = hasCursor ? Number(params.cursor) : Math.max(0, Math.floor(Number(params.offset) || 0));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) return failure('INVALID_RESPONSE');
    return { offset: offset, limit: Math.max(1, Math.min(30, Math.floor(Number(params.limit) || 20))) };
  }
  function paged(items, state, total, more, consumed) {
    const count = consumed === undefined ? items.length : consumed;
    const hasMore = count > 0 && (typeof more === 'boolean' ? more : Number.isFinite(Number(total)) ? state.offset + count < Number(total) : count === state.limit);
    const result = { items: items, hasMore: hasMore };
    if (hasMore) result.nextCursor = String(state.offset + count);
    return finish(result, state);
  }
  function item(type, value) { const result = { type: type }; result[type] = value; return result; }
  function playlist(value, own) {
    if (!value) return null;
    const id = String(value.tid || value.id || value.dissid || '');
    const title = text(value.title || value.dissname || value.diss_name || value.dirName || value.name);
    if (!/^\d{1,16}$/.test(id) || !title) return null;
    const cover = value.cover || {};
    const result = {
      playlistId: id, title: title,
      artworkUrl: image(value.picurl || cover.default_url || cover.medium_url || value.cover_url_medium || value.cover_url_small || value.diss_cover || value.imgurl || value.logo || value.pic || value.albumPic),
      creatorName: text(value.host_nick || value.nickname || (value.creator || value.creator_info || {}).nick || (value.creator || {}).name),
      description: text(value.desc || value.description)
    };
    const count = value.songnum === undefined ? value.song_cnt === undefined ? value.song_num : value.song_cnt : value.songnum;
    if (Number.isFinite(Number(count)) && Number(count) >= 0) result.trackCount = Number(count);
    if ((own === true || Number(value.owndir) === 1) && editableDirectory(value.dirid || value.dirId)) result.editableActions = EDIT_ACTIONS.slice();
    return result;
  }
  function chart(value) {
    if (!value || !(Number(value.topId) > 0) || !value.title) return null;
    return { playlistId: 'chart:' + value.topId, title: text(value.title), artworkUrl: image(value.musichallPicUrl || value.frontPicUrl), trackCount: Math.max(0, Number(value.totalNum) || 0), description: text(value.intro) };
  }
  function album(value) {
    if (!value) return null;
    const id = String(value.albumMid || value.albummid || value.albumMID || value.mid || '');
    const title = text(value.albumName || value.albumname || value.album_name || value.name || value.title);
    if (!mid(id) || !title) return null;
    const singers = value.singers || value.singer_list || value.vec_singer || value.singer || value.singerName || value.singername || [];
    const artists = Array.isArray(singers) ? singers.map(function (singer) {
      const result = { name: text(singer.name || singer.title || singer.singerName) };
      if (mid(String(singer.mid || singer.singerMID || ''))) result.artistId = String(singer.mid || singer.singerMID);
      return result;
    }).filter(function (artist) { return artist.name; }) : String(singers).split('/').filter(Boolean).map(function (name) { return { name: text(name) }; });
    const result = { albumId: id, title: title, artists: artists, artworkUrl: image(value.pic || value.albumPic || value.imgurl || value.logo) || photo('T002', value.pmid || (value.photo || {}).pic_mid || id), description: text(value.desc || (value.ex || {}).desc) };
    const count = value.totalNum === undefined ? value.song_num : value.totalNum;
    if (Number(count) > 0) result.trackCount = Number(count);
    return result;
  }
  function artist(value) {
    if (!value) return null;
    const basic = value.basic_info || value;
    const id = String(basic.singer_mid || basic.singerMid || basic.singerMID || basic.MID || basic.mid || '');
    const name = text(basic.name || basic.singerName || basic.Name);
    if (!mid(id) || !name) return null;
    return { artistId: id, name: name, artworkUrl: image(basic.singerPic || basic.AvatarUrl) || photo('T001', basic.singer_pmid || id), description: text((value.ex_info || {}).desc || value.description) };
  }
  function requireAuth(context) {
    const login = account(context);
    if (!login.present) return failure('AUTH_REQUIRED');
    return !login.hasKey || login.uin === '0' ? failure('AUTH_EXPIRED') : null;
  }
  function cgi(path, params, state, context) {
    if (state.error) return failure(state.error);
    const cookie = cookieText(context);
    if (/[\r\n\u0000]/.test(cookie)) return failure('INVALID_RESPONSE');
    const comm = webComm(context);
    const values = Object.assign({ format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'yqq.json', g_tk: comm.g_tk, g_tk_new_20200303: comm.g_tk_new_20200303, loginUin: account(context).uin, hostUin: 0 }, params);
    const query = Object.keys(values).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key])); }).join('&');
    const headers = { Accept: 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA };
    if (cookie) headers.Cookie = cookie;
    state.key = '@cgi'; state.guid = state.guid || guid(context);
    return { request: { url: 'https://c.y.qq.com' + path + '?' + query, method: 'GET', headers: headers }, state: state };
  }
  function batch(nodes, state, context, lite) {
    const result = request('@batch', '', '', {}, state, context, lite);
    if (result.error) return result;
    const body = JSON.parse(result.request.body); delete body['@batch'];
    Object.keys(nodes).forEach(function (key) { body[key] = nodes[key]; });
    result.request.body = JSON.stringify(body);
    return result;
  }
  function moduleCall(module, method, param) { return { module: module, method: method, param: param }; }
  function node(payload, key, context) {
    const entry = payload[key];
    if (!entry) return failure('INVALID_RESPONSE');
    const code = Number(entry.code) || 0;
    if ([1000, 1004, 101010, 104009, 80030, 80050].indexOf(code) >= 0) return authError(context);
    if (code !== 0) return failure('UNAVAILABLE');
    return entry.data && typeof entry.data === 'object' ? entry.data : failure('INVALID_RESPONSE');
  }
  function profile(state, context) {
    return cgi('/rsc/fcgi-bin/fcg_get_profile_homepage.fcg', { cid: 205360838, ct: 24, userid: 0, reqfrom: 1, reqtype: 0, needNewCode: 0 }, state, context);
  }
  function playlistRequest(params, stage, context, extra) {
    const state = Object.assign({}, page(params), extra, { stage: stage, playlistId: String(params.playlistId || '') });
    const chartMatch = /^chart:(\d{1,6})$/.exec(state.playlistId);
    if (chartMatch) return request('chart', 'musicToplist.ToplistInfoServer', 'GetDetail', { topid: Number(chartMatch[1]), offset: state.offset, num: state.limit }, Object.assign(state, { chart: true }), context, false);
    if (!/^\d{1,16}$/.test(state.playlistId) || !Number.isSafeInteger(Number(state.playlistId))) return failure('NOT_FOUND');
    return request('playlist', 'music.srfDissInfo.aiDissInfo', 'uniform_get_Dissinfo', { disstid: Number(state.playlistId), userinfo: 1, tag: 1, orderlist: 1, song_begin: state.offset, song_num: stage === 'playlist.get' || stage === 'playlist-own' ? 1 : state.limit, onlysonglist: 0, enc_host_uin: '' }, state, context, false);
  }
  function collection(params, context, save) {
    const denied = requireAuth(context); if (denied) return denied;
    const id = String(params.id || ''); const type = params.type;
    const state = { stage: save ? 'mutation' : 'saved', id: id, type: type, allowEmpty: save };
    const login = account(context);
    if (type === 'playlist') {
      if (!/^\d{1,16}$/.test(id) || !Number.isSafeInteger(Number(id))) return failure('UNSUPPORTED');
      // The website passes its raw QQ uin Cookie for this particular CGI parameter.
      return request('collection', 'music.musicasset.PlaylistFav' + (save ? 'Write' : 'Read'), save ? params.saved ? 'FavPlaylist' : 'CancelFavPlaylist' : 'IsPlaylistFan', save ? { uin: cookieFields(context).uin || login.uin, v_playlistId: [Number(id)] } : { v_tid: [Number(id)] }, state, context, false);
    }
    if (!mid(id)) return failure('NOT_FOUND');
    if (type === 'album') return request('collection', 'music.musicasset.AlbumFav' + (save ? 'Write' : 'Read'), save ? params.saved ? 'FavAlbum' : 'CancelFavAlbum' : 'IsAlbumFan', { uin: login.uin, v_albumMid: [id] }, Object.assign(state, { checkResult: save }), context, false);
    if (type === 'artist') return request('collection', 'Concern.ConcernSystemServer', save ? 'cgi_concern_user_v2' : 'cgi_qry_concern_status', save ? { opertype: params.saved ? 0 : 1, source: 0, userinfo: { usertype: 1, userid: id }, encrypt_singerid: 1 } : { vec_userinfo: [{ usertype: 1, userid: id }], opertype: 5, encrypt_singerid: 1 }, state, context, false);
    return failure('UNSUPPORTED');
  }
  function library(operation, params, context) {
    const denied = requireAuth(context); if (denied) return denied;
    const state = Object.assign(page(params), { stage: operation });
    const login = account(context);
    if (operation === 'library.likedTracks') return profile(Object.assign(state, { stage: 'liked-profile' }), context);
    if (operation === 'library.createdPlaylists') return cgi('/rsc/fcgi-bin/fcg_user_created_diss', { hostuin: login.uin, sin: state.offset, size: Math.max(30, state.limit + 10) }, state, context);
    if (operation === 'library.savedPlaylists' || operation === 'library.savedAlbums') return cgi('/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', { ct: 20, cid: 205360956, userid: login.uin, reqtype: operation === 'library.savedPlaylists' ? 3 : 2, sin: state.offset, ein: state.offset + state.limit - (operation === 'library.savedAlbums' ? 1 : 0) }, state, context);
    return request('library', 'music.concern.RelationList', 'GetFollowSingerList', { From: state.offset, Size: state.limit, HostUin: '' }, state, context, false);
  }
  function feed(params, context) {
    const state = Object.assign(page(params), { stage: 'feed', categoryId: String(params.categoryId || '') });
    const nodes = { categories: moduleCall('music.web_category_svr', 'get_hot_category', { location: 0 }) };
    if (/^\d{1,8}$/.test(state.categoryId)) {
      nodes.category = moduleCall('playlist.PlayListPlazaServer', 'get_playlist_by_category', { id: Number(state.categoryId), curPage: Math.floor(state.offset / state.limit) + 1, size: state.limit, order: 5, titleid: Number(state.categoryId) });
    } else {
      if (!state.categoryId || state.categoryId === 'recommend') nodes.recommend = moduleCall('music.playlist.PlaylistSquare', 'GetRecommendFeed', { From: state.offset, Size: state.limit });
      if (!state.categoryId || state.categoryId === 'tracks') nodes.songs = moduleCall('newsong.NewSongServer', 'get_new_song_info', { type: 5 });
      if (!state.categoryId || state.categoryId === 'albums') nodes.albums = moduleCall('newalbum.NewAlbumServer', 'get_new_album_info', { area: 1, sin: state.offset, num: state.limit });
      if (!state.categoryId || state.categoryId === 'charts') nodes.charts = moduleCall('musicToplist.ToplistInfoServer', 'GetAll', {});
      if (Object.keys(nodes).length === 1) return failure('UNSUPPORTED');
    }
    return batch(nodes, state, context, false);
  }
  function mutation(params, context, operation) {
    const denied = requireAuth(context); if (denied) return denied;
    if (operation === 'playlist.create') {
      const title = String(params.title || '').trim(); const desc = String(params.description || '');
      if (!title || title.length > 20 || desc.length > 2000) return failure('UNSUPPORTED');
      return request('mutation', 'music.musicasset.PlaylistBaseWrite', 'AddPlaylist', { dirName: title, dirDesc: desc, dirPicUrl: '', taglist: '', dirShow: 1 }, { stage: 'created', title: title, description: desc }, context, false);
    }
    if (operation === 'track.like') return detail(params.trackId, 'like-detail', context, { liked: params.liked === true });
    if (!/^\d{1,16}$/.test(String(params.playlistId || ''))) return failure('UNSUPPORTED');
    if (operation === 'playlist.update' && ((params.title !== undefined && (!String(params.title).trim() || String(params.title).trim().length > 20)) || String(params.description || '').length > 2000)) return failure('UNSUPPORTED');
    if (/Tracks$/.test(operation) && (!Array.isArray(params.trackIds) || params.trackIds.length < 1 || params.trackIds.length > 30 || params.trackIds.some(function (id) { return !mid(id); }))) return failure('UNSUPPORTED');
    return playlistRequest({ playlistId: params.playlistId, limit: 1 }, 'playlist-own', context, { mutation: operation, params: params });
  }
  const operations = {
    'feed.home': feed, 'feed.discover': feed,
    'catalog.search': function (params, context) {
      const state = Object.assign(page(params), { stage: 'search', type: params.type || 'track', typed: Number(context.apiVersion) >= 2 });
      const types = { track: 0, artist: 1, album: 2, playlist: 3 };
      if (!Object.hasOwn(types, state.type)) return failure('UNSUPPORTED');
      return request('request', 'music.search.SearchCgiService', 'DoSearchForQQMusicLite', { query: String(params.query || '').trim(), search_type: types[state.type], page_num: Math.floor(state.offset / state.limit) + 1, num_per_page: state.limit, highlight: 0, nqc_flag: 0, page_id: 1, grp: 1 }, state, context, true);
    },
    'catalog.track': function (params, context) { return detail(params.trackId, 'detail', context); },
    'lyrics.get': function (params, context) { return detail(params.trackId, 'lyrics-detail', context); },
    'playback.resolve': function (params, context) {
      const denied = requireAuth(context); return denied || detail(params.trackId, 'playback-detail', context);
    },
    'playlist.get': function (params, context) { return playlistRequest(params, 'playlist.get', context); },
    'playlist.tracks': function (params, context) { return playlistRequest(params, 'playlist.tracks', context); },
    'album.get': function (params, context) {
      return mid(params.albumId) ? request('album', 'music.musichallAlbum.AlbumInfoServer', 'GetAlbumDetail', { albumMid: params.albumId }, { stage: 'album.get', id: params.albumId }, context, false) : failure('NOT_FOUND');
    },
    'album.tracks': function (params, context) {
      const state = Object.assign(page(params), { stage: 'album.tracks', id: params.albumId });
      return mid(params.albumId) ? request('albumTracks', 'music.musichallAlbum.AlbumSongList', 'GetAlbumSongList', { albumid: 0, albumMid: params.albumId, begin: state.offset, num: state.limit, order: 2 }, state, context, false) : failure('NOT_FOUND');
    },
    'artist.get': function (params, context) {
      return mid(params.artistId) ? request('artist', 'music.musichallSinger.SingerInfoInter', 'GetSingerDetail', { singer_mids: [params.artistId], ex_singer: 1, wiki_singer: 1, group_singer: 0, pic: 1, photos: 0 }, { stage: 'artist.get', id: params.artistId }, context, false) : failure('NOT_FOUND');
    },
    'artist.tracks': function (params, context) {
      const state = Object.assign(page(params), { stage: 'artist.tracks', id: params.artistId });
      return mid(params.artistId) ? request('artistTracks', 'musichall.song_list_server', 'GetSingerSongList', { singerMid: params.artistId, order: 1, begin: state.offset, num: state.limit }, state, context, false) : failure('NOT_FOUND');
    },
    'artist.albums': function (params, context) {
      const state = Object.assign(page(params), { stage: 'artist.albums', id: params.artistId });
      return mid(params.artistId) ? request('artistAlbums', 'music.musichallAlbum.AlbumListServer', 'GetAlbumList', { singerMid: params.artistId, order: 0, begin: state.offset, num: state.limit, songNumTag: 0, singerID: 0 }, state, context, false) : failure('NOT_FOUND');
    },
    'account.get': function (_, context) {
      if (!account(context).present) return finish(null, { guid: guid(context) });
      const denied = requireAuth(context); return denied || profile({ stage: 'account' }, context);
    },
    'track.liked': function (params, context) {
      const denied = requireAuth(context); if (denied) return denied;
      return mid(params.trackId) ? request('liked', 'music.musicasset.SongFavRead', 'IsSongFanByMid', { v_songMid: [params.trackId] }, { stage: 'saved', type: 'track', id: params.trackId }, context, false) : failure('NOT_FOUND');
    },
    'collection.saved': function (params, context) { return collection(params, context, false); },
    'collection.save': function (params, context) { return collection(params, context, true); }
  };
  ['library.likedTracks', 'library.createdPlaylists', 'library.savedPlaylists', 'library.savedAlbums', 'library.followedArtists'].forEach(function (operation) {
    operations[operation] = function (params, context) { return library(operation, params, context); };
  });
  ['track.like', 'playlist.create', 'playlist.update', 'playlist.delete', 'playlist.addTracks', 'playlist.removeTracks'].forEach(function (operation) {
    operations[operation] = function (params, context) { return mutation(params, context, operation); };
  });
  operations.onResponse = function (operation, response, state, context) {
    const data = readResponse(response, state.key, context, state.allowEmpty);
    if (data.error) return data;
    if (state.stage === 'search') {
      const key = { track: 'item_song', artist: 'singer', album: 'item_album', playlist: 'item_songlist' }[state.type];
      const rows = (data.body || {})[key];
      if (!Array.isArray(rows)) return failure('INVALID_RESPONSE');
      const convert = { track: function (value) { return track(value, context); }, artist: artist, album: album, playlist: playlist }[state.type];
      const items = rows.map(function (value) { const parsed = convert(value); return parsed && (state.typed ? item(state.type, parsed) : parsed); }).filter(Boolean);
      return paged(items, state, (data.meta || {}).sum, undefined, rows.length);
    }
    if (state.stage === 'feed') {
      const sections = []; const errors = [];
      const categories = [{ id: 'recommend', title: '推荐' }, { id: 'charts', title: '排行榜' }, { id: 'tracks', title: '新歌' }, { id: 'albums', title: '新碟' }];
      const categoryData = node(data, 'categories', context);
      if (!categoryData.error) (categoryData.category || []).forEach(function (group) { (group.items || []).forEach(function (value) { if (!categories.some(function (entry) { return entry.id === String(value.item_id); })) categories.push({ id: String(value.item_id), title: text(value.item_name) }); }); });
      let more = false;
      function section(key, title, layout, rows, convert, type) {
        const items = rows.map(function (value) { const parsed = convert(value); return parsed && item(type, parsed); }).filter(Boolean);
        if (items.length) sections.push({ id: key, title: title, layout: layout, items: items });
      }
      ['recommend', 'songs', 'albums', 'charts', 'category'].forEach(function (key) {
        if (!data[key]) return;
        const value = node(data, key, context); if (value.error) { errors.push(value); return; }
        if (key === 'recommend') { section(key, '为你推荐', 'playlists', (value.List || []).map(function (entry) { return ((entry.Playlist || {}).basic); }).filter(Boolean), playlist, 'playlist'); more = more || value.HasMore === true; }
        if (key === 'songs') { const rows = value.songlist || []; section(key, '新歌', 'tracks', rows.slice(state.offset, state.offset + state.limit), function (song) { return track(song, context); }, 'track'); more = more || state.offset + state.limit < rows.length; }
        if (key === 'albums') { section(key, '新碟', 'albums', value.albums || [], album, 'album'); more = more || state.offset + state.limit < Number(value.total); }
        if (key === 'charts') { const rows = []; (value.group || []).forEach(function (group) { rows.push.apply(rows, group.toplist || []); }); section(key, '排行榜', 'playlists', rows.slice(state.offset, state.offset + state.limit), chart, 'playlist'); more = more || state.offset + state.limit < rows.length; }
        if (key === 'category') { section(key, (categories.find(function (entry) { return entry.id === state.categoryId; }) || {}).title || '歌单', 'playlists', value.v_playlist || [], playlist, 'playlist'); more = more || state.offset + state.limit < Number(value.total); }
      });
      if (!sections.length && errors.length) return errors[0];
      const result = { sections: sections, categories: categories, hasMore: more };
      if (more) result.nextCursor = String(state.offset + state.limit);
      return finish(result, state);
    }
    if (state.stage === 'detail') { const result = track(data.track_info, context); return result && result.trackId === state.trackId ? finish(result, state) : failure('NOT_FOUND'); }
    if (state.stage === 'lyrics-detail' || state.stage === 'playback-detail' || state.stage === 'like-detail') {
      const song = data.track_info;
      if (!song || song.mid !== state.trackId) return failure('NOT_FOUND');
      if (state.stage === 'lyrics-detail') return request('lyric', 'music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', { songMID: song.mid, songID: song.id, qrc: 0, qrc_t: 0, trans: 1, roma: 0, crypt: 0 }, { stage: 'lyrics', trackId: song.mid, guid: state.guid }, context, false);
      if (state.stage === 'like-detail' && !(Number(song.id) > 0)) return failure('NOT_FOUND');
      if (state.stage === 'like-detail') return request('mutation', 'music.musicasset.PlaylistDetailWrite', state.liked ? 'AddSonglist' : 'DelSonglist', { dirId: 201, v_songInfo: [{ songType: Number(song.type) || 0, songId: song.id }] }, { stage: 'mutation', allowEmpty: true, guid: state.guid }, context, false);
      const denied = requireAuth(context); if (denied) return denied;
      return request('playback', 'music.vkey.GetEVkey', 'GetUrl', { guid: state.guid, songmid: [song.mid], songtype: [Number(song.type) || 0], uin: account(context).uin, loginflag: 1, platform: '20', xcdn: 1 }, { stage: 'playback', trackId: song.mid, file: song.file || {}, guid: state.guid }, context, false);
    }
    if (state.stage === 'lyrics') { const lyric = decodeBase64(data.lyric); return finish(lyric ? { text: lyric, translation: decodeBase64(data.trans) || undefined } : null, state); }
    if (state.stage === 'playback') return resource(data, state, context);
    if (state.stage === 'playlist.get' || state.stage === 'playlist.tracks') {
      if (Number(data.code)) return failure('UNAVAILABLE');
      if (state.stage === 'playlist.get') { const result = state.chart ? chart(data.data) : playlist(data.dirinfo); return result && result.playlistId === state.playlistId ? finish(result, state) : failure('NOT_FOUND'); }
      const rows = state.chart ? data.songInfoList : data.songlist;
      if (!Array.isArray(rows)) return failure('INVALID_RESPONSE');
      return paged(rows.map(function (value) { return track(value, context); }).filter(Boolean), state, state.chart ? (data.data || {}).totalNum : data.total_song_num, undefined, rows.length);
    }
    if (state.stage === 'album.get') {
      const result = album(Object.assign({}, data.basicInfo, { singer: (data.singer || {}).singerList || [] }));
      return result && result.albumId === state.id ? finish(result, state) : failure('NOT_FOUND');
    }
    if (state.stage === 'artist.get') {
      const result = (data.singer_list || []).map(artist).find(function (value) { return value && value.artistId === state.id; });
      return result ? finish(result, state) : failure('NOT_FOUND');
    }
    if (state.stage === 'album.tracks' || state.stage === 'artist.tracks') {
      if (!Array.isArray(data.songList)) return failure('INVALID_RESPONSE');
      return paged(data.songList.map(function (entry) { return track(entry.songInfo, context); }).filter(Boolean), state, data.totalNum, undefined, data.songList.length);
    }
    if (state.stage === 'artist.albums') {
      if (!Array.isArray(data.albumList)) return failure('INVALID_RESPONSE');
      return paged(data.albumList.map(album).filter(Boolean), state, data.total, undefined, data.albumList.length);
    }
    if (state.stage === 'account' || state.stage === 'liked-profile') {
      if (!data.creator || !String(data.creator.uin || '') || !data.creator.nick) return failure('INVALID_RESPONSE');
      if (state.stage === 'account') return finish({ accountId: String(data.creator.uin), displayName: text(data.creator.nick), avatarUrl: image(data.creator.headpic) }, state);
      const favorite = (data.mymusic || []).find(function (value) { return Number(value.type) === 1; });
      if (!favorite || !/^\d{1,16}$/.test(String(favorite.id || ''))) return failure('INVALID_RESPONSE');
      return request('playlist', 'music.srfDissInfo.aiDissInfo', 'uniform_get_Dissinfo', { disstid: Number(favorite.id), song_begin: state.offset, song_num: state.limit, ctx: 1 }, Object.assign(state, { stage: 'liked-tracks' }), context, false);
    }
    if (state.stage === 'liked-tracks') {
      if (Number(data.code)) return failure('UNAVAILABLE');
      if (!Array.isArray(data.songlist)) return failure('INVALID_RESPONSE');
      return paged(data.songlist.map(function (value) { return track(value, context); }).filter(Boolean).map(function (value) { return item('track', value); }), state, data.total_song_num, undefined, data.songlist.length);
    }
    if (state.stage === 'library.createdPlaylists') {
      if (!Array.isArray(data.disslist)) return failure('INVALID_RESPONSE');
      const items = state.createdItems || [];
      const start = state.createdOffset === undefined ? state.offset : state.createdOffset;
      let consumed = 0;
      // System directories do not consume visible slots, but do advance the server cursor.
      while (consumed < data.disslist.length && items.length < state.limit) {
        const value = data.disslist[consumed++];
        if (!editableDirectory(value.dirid)) continue;
        const parsed = playlist(value, true);
        if (parsed) items.push(item('playlist', parsed));
      }
      const next = start + consumed;
      if (!Number.isSafeInteger(next) || next > 2147483647) return failure('INVALID_RESPONSE');
      const total = Number(data.totoal);
      const hasMore = consumed < data.disslist.length || (Number.isSafeInteger(total) && total > next);
      const hops = state.createdHops || 1;
      if (items.length < state.limit && hasMore && consumed === data.disslist.length && consumed > 0 && hops < 4) {
        return cgi('/rsc/fcgi-bin/fcg_user_created_diss', { hostuin: account(context).uin, sin: next, size: Math.max(30, state.limit - items.length + 10) },
          Object.assign({}, state, { createdItems: items, createdOffset: next, createdHops: hops + 1 }), context);
      }
      if (!items.length && hasMore) return failure('INVALID_RESPONSE');
      const result = { items: items, hasMore: hasMore };
      if (hasMore) result.nextCursor = String(next);
      return finish(result, state);
    }
    if (state.stage === 'library.savedPlaylists' || state.stage === 'library.savedAlbums') {
      const isAlbum = state.stage === 'library.savedAlbums'; const rows = isAlbum ? data.albumlist : data.cdlist;
      if (!Array.isArray(rows)) return failure('INVALID_RESPONSE');
      return paged(rows.map(isAlbum ? album : playlist).filter(Boolean).map(function (value) { return item(isAlbum ? 'album' : 'playlist', value); }), state, isAlbum ? data.totalalbum : data.totaldiss, undefined, rows.length);
    }
    if (state.stage === 'library.followedArtists') {
      if (!Array.isArray(data.List)) return failure('INVALID_RESPONSE');
      return paged(data.List.map(artist).filter(Boolean).map(function (value) { return item('artist', value); }), state, data.Total, data.HasMore === true, data.List.length);
    }
    if (state.stage === 'saved') {
      const flags = state.type === 'artist' ? data.map_singer_status : data.m_fan;
      if (!flags || !Object.hasOwn(flags, state.id)) return failure('INVALID_RESPONSE');
      const flag = flags[state.id];
      if ([true, false, 0, 1, '0', '1'].indexOf(flag) < 0) return failure('INVALID_RESPONSE');
      return finish(flag === true || flag === 1 || flag === '1', state);
    }
    if (state.stage === 'created') {
      const result = data.result;
      const id = result && String(result.tid || '');
      return /^\d{1,16}$/.test(id) && editableDirectory(result.dirId) ? finish({ playlistId: id, title: state.title, artworkUrl: '', description: state.description, trackCount: 0, editableActions: EDIT_ACTIONS.slice() }, state) : failure('INVALID_RESPONSE');
    }
    if (state.stage === 'playlist-own') {
      const info = data.dirinfo;
      if (Number(data.code) || !info || String(info.id) !== state.playlistId || Number(info.owndir) !== 1 || !editableDirectory(info.dirid)) return failure('UNSUPPORTED');
      const params = state.params; const op = state.mutation;
      if (op === 'playlist.delete') return request('mutation', 'music.musicasset.PlaylistBaseWrite', 'DelPlaylist', { dirId: Number(info.dirid) }, { stage: 'mutation', allowEmpty: true, guid: state.guid }, context, false);
      if (op === 'playlist.update') return request('mutation', 'music.musicasset.PlaylistBaseWrite', 'EditPlaylist', { dirId: Number(info.dirid), mask: 95, dirNewName: params.title === undefined ? info.title : String(params.title).trim(), dirNewDesc: params.description === undefined ? info.desc || '' : String(params.description), dirNewPicUrl: info.picurl || '', dirNewPicUrl2: info.picurl2 || '', dirNewtaglist: (info.vec_tagid || []).join(','), dirShow: Number(info.dir_show === undefined ? info.show : info.dir_show) || 0 }, { stage: 'mutation', allowEmpty: true, guid: state.guid }, context, false);
      const nodes = {};
      params.trackIds.forEach(function (id, index) { nodes['song' + index] = moduleCall('music.pf_song_detail_svr', 'get_song_detail_yqq', { song_mid: id }); });
      return batch(nodes, { stage: 'playlist-song-details', mutation: op, trackIds: params.trackIds, dirId: Number(info.dirid), guid: state.guid }, context, false);
    }
    if (state.stage === 'playlist-song-details') {
      const songs = [];
      for (let index = 0; index < state.trackIds.length; index++) {
        const detail = node(data, 'song' + index, context); if (detail.error) return detail;
        const song = detail.track_info;
        if (!song || song.mid !== state.trackIds[index] || !(Number(song.id) > 0)) return failure('NOT_FOUND');
        songs.push({ songType: Number(song.type) || 0, songId: Number(song.id) });
      }
      return request('mutation', 'music.musicasset.PlaylistDetailWrite', state.mutation === 'playlist.addTracks' ? 'AddSonglist' : 'DelSonglist', { dirId: state.dirId, v_songInfo: songs }, { stage: 'mutation', allowEmpty: true, guid: state.guid }, context, false);
    }
    if (state.stage === 'mutation') {
      if (data.result === false || (state.checkResult && Number(data.result) !== 0)) return failure('UNAVAILABLE');
      if (data.result !== undefined && typeof data.result === 'number' && data.result !== 0) return failure('UNAVAILABLE');
      return finish(true, state);
    }
    return failure('INVALID_RESPONSE');
  };
  globalThis.sourcePlugin = Object.freeze(operations);
})();
