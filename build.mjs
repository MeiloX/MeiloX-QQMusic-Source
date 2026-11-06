// SPDX-License-Identifier: GPL-3.0-only
import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
const root = new URL('.', import.meta.url);
await build({
  entryPoints: [new URL('src/adapter.js', root).pathname], outfile: new URL('index.js', root).pathname,
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2020', minify: true, legalComments: 'eof',
  banner: { js: '/* MeiloX QQ Music Source: GPL-3.0-only. Includes MIT-licensed noble cryptography; see LICENSE and NOTICE. */' },
});
if ((await stat(new URL('index.js', root))).size > 256 * 1024) throw new Error('The source entry exceeds the SDK limit');
