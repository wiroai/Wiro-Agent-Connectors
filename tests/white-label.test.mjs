import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { builtFile, callTool, fakeFetch, jsonResponse, loadModule, makeContext, refusal, ROOT, textResponse } from './helpers.mjs';

// Connectors are white-label: the only name in what a tool shows is the
// vendor's. No other brand may appear in a module, in a tool's name, title,
// description or schema, or in any text a tool returns, errors included.

const BRAND = /wiro/i;
const require = createRequire(import.meta.url);
const { listVendors } = require('../dist/host/index.js');
const folders = [...listVendors(), '_template'];

function placeholderCredentials(module) {
  return Object.fromEntries(module.credentials.map((name) => [name, `test-${name}`]));
}

test('no built module mentions the brand anywhere', () => {
  for (const folder of folders) {
    assert.doesNotMatch(fs.readFileSync(builtFile(folder), 'utf8'), BRAND, folder);
  }
});

test('the host code a tool result can come from does not mention it either', () => {
  const hostDir = path.join(ROOT, 'dist', 'host');
  for (const file of fs.readdirSync(hostDir).filter((name) => name.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(hostDir, file), 'utf8'), BRAND, file);
  }
});

test('no tool name, title, description or schema mentions it', () => {
  for (const folder of folders) {
    const { module } = loadModule(folder);
    for (const tool of module.tools) {
      for (const text of [tool.name, tool.title, tool.description, JSON.stringify(tool.inputSchema)]) {
        assert.doesNotMatch(text, BRAND, `${folder} ${tool.name}`);
      }
    }
  }
});

const failures = [
  ...[400, 401, 403, 404, 409, 422, 429, 500, 502, 503].map((status) => () => jsonResponse(status, { error: 'SomeError', message: 'Something went wrong' }, { 'retry-after': '5' })),
  () => textResponse(500, '<html><body>Bad gateway</body></html>'),
  () => {
    throw new TypeError('fetch failed');
  },
  () => {
    throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
  },
  () => {
    throw refusal();
  },
];

test('no error text mentions it: bad calls, missing credentials, and every kind of vendor failure', async () => {
  const texts = [];
  for (const folder of folders) {
    const { module } = loadModule(folder);
    const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'vendors', folder, 'smoke.json'), 'utf8'));
    const planned = Object.fromEntries([plan.read, plan.write].filter(Boolean).map((step) => [step.tool, step.args]));
    const credentials = placeholderCredentials(module);

    const ok = makeContext({ credentials, fetch: fakeFetch(() => jsonResponse(200, {})) }).ctx;
    texts.push((await callTool(module, 'no_such_tool', {}, ok)).text);
    for (const tool of module.tools) {
      texts.push((await callTool(module, tool.name, { not_an_argument: true }, ok)).text);
      texts.push((await callTool(module, tool.name, {}, makeContext({ credentials: {}, fetch: ok.fetch }).ctx)).text);
      const args = JSON.parse(JSON.stringify(planned[tool.name] ?? {}).replaceAll('{{timestamp}}', 'now'));
      for (const respond of failures) {
        const { ctx } = makeContext({ credentials, accounts: null, fetch: fakeFetch(respond) });
        texts.push((await callTool(module, tool.name, args, ctx)).text);
      }
    }
  }
  assert.ok(texts.length > 100, `${texts.length} texts checked`);
  for (const text of texts) assert.doesNotMatch(text, BRAND, text);
});
