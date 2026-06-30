# Third-party notices

LyricLens itself is licensed under the GNU Affero General Public License
v3.0 (see [LICENSE](LICENSE)). It bundles or proxies the following
third-party assets, which retain their own licenses.

## Fonts

The landing page at `lyriclens.yoru-and-akari.dev` serves these fonts via
the Worker's `/assets/fonts/*` proxy (R2-cached, lazy-fetched from
jsdelivr). They are not bundled inside the `.plugin` artifact.

### Geist Sans · Geist Mono

- Copyright 2023 Vercel, Inc., with Reserved Font Name "Geist" and "Geist Mono"
- License: SIL Open Font License, Version 1.1
- Source: <https://github.com/vercel/geist-font>
- License text: <https://github.com/vercel/geist-font/blob/main/LICENSE.TXT>

### Zen Kaku Gothic New

- Copyright 2021 The Zen Kaku Gothic New Project Authors
- License: SIL Open Font License, Version 1.1
- Source: <https://github.com/googlefonts/zen-kakugothic>
- License text: <https://github.com/googlefonts/zen-kakugothic/blob/main/OFL.txt>

## SIL Open Font License 1.1 — summary of obligations

The OFL allows free use, study, modification and redistribution of the
fonts above, with these conditions: (a) the fonts may not be sold by
themselves; (b) modified versions must carry a different name; (c) the
copyright notice and license must travel with any redistribution.
Serving the original woff2 files unmodified through our CDN proxy
satisfies (c) when this NOTICES file is present in the repository. Full
license text at <https://openfontlicense.org/>.

## Runtime dependencies

LyricLens has no npm dependencies (`package.json` lists none). The
plugin is loaded by [BetterNCM](https://github.com/MicroCBer/BetterNCM)
at runtime; it reads NCM globals and DOM but does not vendor or fork
BetterNCM or AMLL ([applemusic-like-lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics))
source code.
