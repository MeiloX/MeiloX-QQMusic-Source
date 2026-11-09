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

1. Import the package in Settings → General → Audio Sources. Review the requested
   domains when updating, including the declared audio CDN.
2. Choose **网页登录** in the source settings or account page. Scan the official QR
   code with QQ on another phone and confirm the authorization, then finish the
   page. MeiloX extracts only the declared session Cookies and verifies the account
   before saving them.
3. Select QQ Music from the source menu.

Manual configuration remains available. Sign in at `https://y.qq.com/` in a desktop
browser, open DevTools → Network, and copy the complete **Request Headers → Cookie**
from a request to `u.y.qq.com` or `c.y.qq.com` into the QQ source's Cookie field.
Leave account ID blank when the Cookie contains `uin`/`wxuin`/`p_uin`; otherwise
enter the ID from the same session. Long WeChat IDs remain strings. Changing the
manual Cookie replaces a previously saved web session.

This is the user's own web session, not a QQ password. MeiloX encrypts the source
configuration with Android Keystore. The adapter sends it only to the exact QQ API
hosts; artwork/audio requests never receive the Cookie. Renew the session when QQ
rejects authorization.

## Web login contract

Version 0.3.2 declares `login.webLogin`, `login.sessionState`, `login.logout` and the
`account/login` route. It uses the existing `web.auth` host effect, a fixed QQ OAuth
client and the official HTTPS callback at `y.qq.com/portal/wx_redirect.html`.
The login opens QQ's official Graph `show?which=Login` wrapper with the HTTPS
`y.qq.com/portal/wx_redirect.html` callback. Its official XUI iframe runs
naturally, preserving `style=40`, `force_qr=1`, and the Graph `login_jump` return
state for the QR authorization layout with the stable full-height PC template.
Its HTTPS mobile scripts at
`jsapi.qq.com` and
`open.mobile.qq.com` are covered by maintained official-root grants (`*.qq.com`,
`*.gtimg.com`, `*.gtimg.cn`, `*.cdn-go.cn`, `*.qpic.cn`, and `*.idqqimg.cn`); audio remains
separately scoped to `*.stream.qqmusic.qq.com`. Cookie export
collects the thirteen fixed credential/identity names only from the concrete
authorized chain (`y.qq.com`, `i2.y.qq.com`, Graph/XUI and QQ callback hosts).
Same-name cookies with conflicting values are rejected, and `pt_*` intermediate
cookies are never exported; it does not export the whole browser cookie jar.

The continuation stays in host-owned invocation state, expires after thirty minutes
and remains bound to the original source session. Captured credentials are verified
through QQ Music's `userid=0` self-profile endpoint. Only that successful final
response commits protocol storage and returns `{authenticated:true,...profile}`.
`sessionState` returns `{authenticated,kind:'web'|null}`; `logout` returns `true` and
clears the active session, including an earlier manual Cookie until it is edited.
Durable source storage contains only `guid`, `cookie` and a manual-configuration
fingerprint. Public profiles and catalog responses remain host-owned data.

## Playback

Playback uses `music.vkey.GetEVkey/GetUrl` and remains subject to QQ's session and
account rights. Version 0.3 passed real Android-host playback with the decoded full
track duration verified. Trial segments are rejected, and the returned filename determines actual audio quality. Audio
uses `NO_STORE` without offline caching or downloads. The audio grant
`*.stream.qqmusic.qq.com` covers QQ Music's regional and nested CDN hosts. Matching
requires a complete DNS-label boundary and excludes the apex `stream.qqmusic.qq.com`.
Returned audio stays HTTPS, with the existing port, redirect and credential controls.
Absolute playback URLs keep their original approved host.

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
Web-login tests cover fixed URL/Cookie scope, final credential verification, session
retention across reads, logout, manual renewal, cancellation and stale continuations.
Clock-controlled cases verify account validation after ten minutes and rejection
without stored credentials after the thirty-minute limit.
Audio-domain tests cover existing, regional and nested CDN hosts, plus rejected apex,
suffix lookalikes, malformed DNS labels, userinfo and port overrides.
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
visible rows when system directories are filtered. Authenticated search uses the
website Desktop contract. Its anonymous Lite fallback shares the same four-request
budget, including when QQ returns a success-shaped empty authentication gate.

The Android compatibility run also verified all four authenticated search types,
home/discovery, content details and all five personal library collections. Live
checks were read-only; account mutations remain covered by offline contract tests.

## Sources and license

Primary contracts: [search](https://y.qq.com/ryqq/js/search.chunk.08cc51fcb18dcb9c18f2.js), [home](https://y.qq.com/ryqq/js/index.chunk.ace96907d7435166d469.js),
[playlist](https://y.qq.com/ryqq/js/playlist.chunk.b75ba461c24b12c4d024.js),
[playlist editing](https://y.qq.com/ryqq/js/playlist_edit.chunk.2725441057c73cad7c10.js),
[artist](https://y.qq.com/ryqq/js/singer.chunk.ff1d987fc9286d39b86c.js),
[player](https://y.qq.com/ryqq/js/player.chunk.d0a478ab3d586bf78298.js),
[transport](https://y.qq.com/ryqq/js/vendor.chunk.d8b4489cbdb338cb0470.js),
[account/library](https://y.qq.com/ryqq/js/common.chunk.5b378f933e2203b7da48.js).
That official common bundle also defines the QQ OAuth client, redirect URI and
login Cookie names; the public OAuth and callback pages supply the declared login
and captcha resource hosts.
The separate [partner OpenAPI](https://y.qq.com/music_developer/static/docs/OpenAPI/overview.md)
has its own application and distribution requirements.

[GPL-3.0-only](LICENSE). The qmweb-sign protocol source and noble SHA-1/AES-GCM libraries are MIT-licensed;
[NOTICE](NOTICE) contains their complete copyright and permission notices.
