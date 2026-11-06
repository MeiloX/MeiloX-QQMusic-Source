# MeiloX QQ Music Source

A standalone source plugin for [MeiloX](https://github.com/NEORUAA/MeiloX).

QQ Music home recommendations, discovery categories and charts, track/playlist/
album/artist search, collection details, lyrics, and personal account/library access.
Favorites, followed artists, playlist creation/editing/deletion, and adding/removing
tracks use the website's own contracts. Playlist edits require confirmed ownership.
Reordering and cover uploads are not declared.

Version 0.3 adapts the MIT-licensed [qmweb-sign](https://github.com/jixunmoe/qmweb-sign)
AG1 protocol with synchronous SHA-1/AES-GCM and binary response decoding. The source
is pinned to commit `15305a3cc39f80eb1646ab2bae46468231765736`.
It requires a MeiloX API 2 host with `secureRandomBase64` and Base64 HTTP responses.
The installable [`qq-music.meisource`](qq-music.meisource) includes its dependencies.

## Configure

1. Import the package in Settings → General → Audio Sources. Updating from 0.1
   requires reviewing the additional website/artwork domains; 0.3 adds no domains.
2. Sign in at `https://y.qq.com/` in a desktop browser. Open DevTools → Network,
   reload, and copy the complete **Request Headers → Cookie** from a request to
   `u.y.qq.com` or `c.y.qq.com` into the QQ source's password field.
3. Leave account ID blank when the Cookie contains `uin`/`wxuin`/`p_uin`. Otherwise
   enter the ID from the same session. Long WeChat IDs remain strings.
4. Save and select QQ Music from the source menu.

This is the user's own web session, not a QQ password. MeiloX encrypts the source
configuration with Android Keystore. The adapter sends it only to the exact QQ API
hosts; artwork/audio requests never receive the Cookie. Renew the session when QQ
rejects authorization.

## Playback

Playback uses `music.vkey.GetEVkey/GetUrl` and remains subject to QQ's session and
account rights. Live full playback with 0.3 is awaiting validation. Trial segments
are rejected, and the returned filename determines actual audio quality. Audio
uses `NO_STORE` without offline caching or downloads. Only the declared website
fallback CDN is accepted; adding another requires a reviewed package update.

## Development

Node.js 20.19+ and Python 3 are required. Dependencies are pinned in the lockfile.
No Android checkout is needed.

```sh
npm ci --ignore-scripts
npm test
python3 package.py
```

Edit `src/adapter.js` and `src/transport.js`; `index.js` is the generated, standalone
entry. The ZIP includes only manifest, bundled JavaScript, LICENSE, and NOTICE.
The entry is checked against the SDK's 256 KiB limit.

Default tests run offline with captured public metadata and synthetic account/
write responses. Protocol vectors use published MIT reference vectors and locally constructed public text.
A separate offline comparison uses the pinned MIT reference in `vendor/qmweb-sign`.
Public integration checks are explicitly enabled and send no Cookies or account writes:

```sh
npm run verify:reference
npm run test:public
```

Ordinary playlist IDs are global QQ `tid` values; charts use read-only `chart:<id>`.
Account-local directory IDs are read from an ownership-checked response. Liked
tracks use the profile's favorites playlist ID for reading and directory 201 for
the website's favorite action. Pagination keeps server cursors separate from
visible rows when system directories are filtered.

## Sources and license

Primary contracts: [home](https://y.qq.com/ryqq/js/index.chunk.ace96907d7435166d469.js),
[playlist](https://y.qq.com/ryqq/js/playlist.chunk.b75ba461c24b12c4d024.js),
[playlist editing](https://y.qq.com/ryqq/js/playlist_edit.chunk.2725441057c73cad7c10.js),
[artist](https://y.qq.com/ryqq/js/singer.chunk.ff1d987fc9286d39b86c.js),
[player](https://y.qq.com/ryqq/js/player.chunk.d0a478ab3d586bf78298.js),
[transport](https://y.qq.com/ryqq/js/vendor.chunk.d8b4489cbdb338cb0470.js),
[account/library](https://y.qq.com/ryqq/js/common.chunk.5b378f933e2203b7da48.js).
The separate [partner OpenAPI](https://y.qq.com/music_developer/static/docs/OpenAPI/overview.md)
has its own application and distribution requirements.

[GPL-3.0-only](LICENSE). The qmweb-sign protocol source and noble SHA-1/AES-GCM libraries are MIT-licensed;
[NOTICE](NOTICE) contains their complete copyright and permission notices.
