// SPDX-License-Identifier: GPL-3.0-only
// Offline comparison against pinned, MIT-licensed upstream code, never a proprietary VM.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { PUBLIC_AG1 } from '../src/protocol-constants.js';
import { signBody, encryptBody, decodeHostResponse } from '../src/transport.js';
const upstream = new URL('../vendor/qmweb-sign/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('UPSTREAM.json', upstream), 'utf8'));
for (const [name, expected] of Object.entries(metadata.files)) {
  const actual = await readFile(new URL(name.replace(/^src\//, ''), upstream));
  assert.ok(createHash('sha256').update(actual).digest('hex') === expected, 'Pinned MIT reference changed');
}
const temporary = await mkdtemp(join(tmpdir(), 'qq-mit-reference-'));
try {
  const output = join(temporary, 'reference.mjs');
  await build({ entryPoints: [new URL('node.ts', upstream).pathname], outfile: output, bundle: true, platform: 'node', target: 'node20', format: 'esm' });
  const reference = await import(pathToFileURL(output).href);
  const iv = new Uint8Array(Array.from({ length: 12 }, (_, index) => index));
  for (let index = 0; index < 100; index++) {
    const body = JSON.stringify({ code: 0, comm: { uin: 0 }, public: '公开 vector ' + index, padding: 'x'.repeat(index) });
    assert.ok(signBody(body) === reference.zzcSign(body), 'Pinned MIT signature mismatch');
    assert.ok(await reference.decodeAG1Request(encryptBody(body, iv)) === body, 'Pinned MIT request framing mismatch');
    const wire = Buffer.from(body, 'utf8');
    for (let byte = 0; byte < wire.length; byte++) wire[byte] ^= PUBLIC_AG1.responseMask[byte % PUBLIC_AG1.responseMask.length];
    assert.ok(reference.decodeAG1Response(new Uint8Array(wire)) === body, 'Pinned MIT response framing mismatch');
    assert.ok(decodeHostResponse({ body: '', bodyBase64: wire.toString('base64') }).body === body, 'Binary host response mismatch');
  }
  console.log('Pinned qmweb-sign MIT reference: 100 offline transport comparisons passed.');
} finally { await rm(temporary, { recursive: true, force: true }); }
