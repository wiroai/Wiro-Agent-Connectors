import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// The host building blocks other programs use: the module check and the
// environment mapping of the CLI.

const require = createRequire(import.meta.url);
const { assertConnectorModule } = require('../dist/host/index.js');

const base = { vendor: 'acme', origins: ['https://api.acme.test'], originFields: [], credentials: ['api_key'], tools: [], call: async () => ({ content: [] }) };

test('a module may name its API by an origin field instead of a fixed origin, but must name one', () => {
  assert.doesNotThrow(() => assertConnectorModule(base, 'acme'));
  assert.doesNotThrow(() => assertConnectorModule({ ...base, origins: [], originFields: ['site_url'], credentials: ['site_url'] }, 'acme'));
  const { originFields: _none, ...older } = base;
  assert.doesNotThrow(() => assertConnectorModule(older, 'acme'), 'a module built before originFields existed');
  assert.throws(() => assertConnectorModule({ ...base, origins: [] }, 'acme'), /it names no origins/);
  assert.throws(() => assertConnectorModule({ ...base, originFields: ['site_url'] }, 'acme'), /an origin field is not one of its credentials/);
  assert.throws(() => assertConnectorModule({ ...base, originFields: 'site_url' }, 'acme'), /originFields is not a list/);
});
