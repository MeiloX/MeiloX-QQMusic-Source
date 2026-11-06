# MeiloX QQ Music Source

A source plugin for [MeiloX](https://github.com/NEORUAA/MeiloX).

This experimental API 2 source uses QQ Music's website endpoints. It supplies home
recommendations, discovery categories, charts, track/playlist/album/artist search,
collection details, lyrics, and personal account/library access. It requires MeiloX
with source API 2 support. No account or third-party resolver is bundled.

Anonymous catalog operations were verified on 2026-11-06. Personal features require
the user's own QQ Music web session. Favorites, followed artists, playlist creation,
editing, deletion, and adding/removing tracks follow the website's request contracts.
Playlist edits require the server to identify the playlist as owned by this session.
Reordering and cover uploads are not declared.

## Configure in MeiloX

1. Import `qq-music.meisource` in Settings → General → Audio Sources. Updating from
   0.1 requires reviewing the added website and artwork domains.
2. In a desktop browser, sign in at `https://y.qq.com/`. Open DevTools → Network,
   reload, and copy the complete **Request Headers → Cookie** from a request to
   `u.y.qq.com` or `c.y.qq.com` into the QQ source's password field. This is the
   session Cookie, not a QQ password or a single key value.
3. Leave account ID blank when the Cookie contains `uin`/`wxuin`/`p_uin`. Otherwise
   enter the ID belonging to the same session. Long WeChat IDs remain strings.
4. Save, then choose QQ Music from the source menu.

Credentials stay in this plugin's Keystore-protected configuration. The adapter
sends them only to the exact `u.y.qq.com` and `c.y.qq.com` API hosts. Artwork and audio
requests never receive the Cookie. Do not paste credentials into logs or issues.
Expired or rejected authorization returns `AUTH_EXPIRED`; Netease login is separate.

## Playback

The current website player uses `music.vkey.GetEVkey/GetUrl`. On this date, anonymous
requests and the tested personal session were refused with no full audio URL. The
current website request wrapper also uses its own signed, encrypted `musics.fcg`
transport. This adapter does not reproduce platform signing secrets or bypass that
transport. Supplying a Cookie alone therefore does not establish playback access.

When QQ grants a full resource, its filename determines the reported quality.
`RS02` trial segments are rejected, including encoded or mislabeled paths. Audio
uses `NO_STORE`, with no download or offline audio cache. Only the declared fallback
CDN `ws6.stream.qqmusic.qq.com` is accepted. Additional CDNs require a reviewed
package update; redirects stay subject to host restrictions.

## Contracts and package

This repository is self-contained. Node.js runs the offline contract tests; Python 3
uses only its standard library to build the package. No MeiloX checkout or Android
build is required. The installable artifact is [`qq-music.meisource`](qq-music.meisource).

```sh
node test.mjs
python3 package.py
```

The runner has no network client. Captured fixtures contain projected public
metadata; the lyric fixture contains only LRC metadata tags. Private account and
write responses are synthetic. These verify request formation and navigation,
not successful changes to an account or live playback. The ZIP includes only its
manifest and JavaScript, without fixtures or credentials.

Ordinary playlist IDs are global QQ `tid` values. Charts use `chart:<topid>` and are
read-only. Account-local `dirId` values are obtained from an ownership-checked
playlist response, never guessed from a global ID. Liked tracks use the account
profile's favorites playlist ID for reading and the website's directory 201 for
its explicit favorite action.

Primary contracts:
[home](https://y.qq.com/ryqq/js/index.chunk.ace96907d7435166d469.js),
[playlist](https://y.qq.com/ryqq/js/playlist.chunk.b75ba461c24b12c4d024.js),
[playlist editing](https://y.qq.com/ryqq/js/playlist_edit.chunk.2725441057c73cad7c10.js),
[artist](https://y.qq.com/ryqq/js/singer.chunk.ff1d987fc9286d39b86c.js),
[player](https://y.qq.com/ryqq/js/player.chunk.d0a478ab3d586bf78298.js),
[request wrapper](https://y.qq.com/ryqq/js/vendor.chunk.d8b4489cbdb338cb0470.js),
[account/library helpers](https://y.qq.com/ryqq/js/common.chunk.5b378f933e2203b7da48.js).
This is not the separate licensed
[partner OpenAPI](https://y.qq.com/music_developer/static/docs/OpenAPI/overview.md),
which has its own application and distribution requirements.

## License

[GPL-3.0-only](LICENSE), inherited from MeiloX. See [NOTICE](NOTICE) for provenance.
