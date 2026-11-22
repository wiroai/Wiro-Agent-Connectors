import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { forbiddenIn } from '../scripts/module-sandbox.mjs';
import { builtFile, loadModule, ROOT } from './helpers.mjs';

// Every built module keeps the module interface that hosts rely on.

const require = createRequire(import.meta.url);
const { envNameFor, listVendors } = require('../dist/host/index.js');
const { validateArguments } = require('../build/core.js');

const vendors = listVendors();
const folders = [...vendors, '_template'];
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('every vendor folder was built, and nothing else', () => {
  const sources = fs.readdirSync(path.join(ROOT, 'src', 'vendors')).filter((name) => !name.startsWith('_') && fs.existsSync(path.join(ROOT, 'src', 'vendors', name, 'index.ts')));
  assert.deepEqual(vendors, sources.sort());
  assert.ok(vendors.length >= 3);
});

for (const folder of folders) {
  test(`${folder}: exports exactly { vendor, origins, originFields, credentials, tools, call }`, () => {
    const { module } = loadModule(folder);
    assert.deepEqual(Object.keys(module), ['vendor', 'origins', 'originFields', 'credentials', 'tools', 'call']);
    assert.match(module.vendor, /^[a-z][a-z0-9-]{1,29}$/);
    if (folder !== '_template') assert.equal(module.vendor, folder);
    for (const origin of module.origins) assert.equal(new URL(origin).origin, origin);
    for (const origin of module.origins) assert.ok(origin.startsWith('https://'), origin);
    for (const name of module.credentials) assert.match(name, /^[a-z][a-z0-9_]*$/);
    assert.ok(Array.isArray(module.originFields), 'originFields is a list, empty when unused');
    for (const name of module.originFields) assert.ok(module.credentials.includes(name), `origin field ${name} is a credential`);
    assert.ok(module.origins.length > 0 || module.originFields.length > 0, 'it names where it may connect');
    assert.equal(typeof module.call, 'function');
  });

  test(`${folder}: the built file is dependency-free and uses no Node or global network API`, () => {
    assert.deepEqual(forbiddenIn(fs.readFileSync(builtFile(folder), 'utf8')), []);
  });

  test(`${folder}: every tool has a schema and all four annotations, consistent with each other`, () => {
    const { module } = loadModule(folder);
    const names = new Set();
    for (const tool of module.tools) {
      assert.deepEqual(Object.keys(tool), ['name', 'title', 'description', 'inputSchema', 'annotations']);
      assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/);
      assert.equal(names.has(tool.name), false);
      names.add(tool.name);
      assert.ok(tool.title.length > 0 && tool.description.length > 0);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      for (const required of tool.inputSchema.required ?? []) assert.ok(required in tool.inputSchema.properties, `${tool.name}.${required}`);
      const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = tool.annotations;
      for (const hint of [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]) assert.equal(typeof hint, 'boolean');
      if (readOnlyHint) {
        assert.equal(destructiveHint, false, `${tool.name}: a read-only tool is not destructive`);
        assert.equal(idempotentHint, true, `${tool.name}: a read-only tool is idempotent`);
      }
    }
  });

  test(`${folder}: has its own tests and a smoke plan whose arguments fit the tools`, () => {
    const dir = path.join(ROOT, 'src', 'vendors', folder);
    assert.ok(fs.readdirSync(dir).some((name) => name.endsWith('.test.mjs')), 'a test file next to the module');
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'smoke.json'), 'utf8'));
    const { module } = loadModule(folder);
    for (const step of [plan.read, plan.write].filter(Boolean)) {
      const tool = module.tools.find((candidate) => candidate.name === step.tool);
      assert.ok(tool, `smoke.json names ${step.tool}`);
      const args = JSON.parse(JSON.stringify(step.args).replaceAll('{{timestamp}}', '2026-11-21T00:00:00.000Z'));
      const checked = validateArguments(tool.inputSchema, args);
      assert.equal(checked.ok, true, checked.issues?.join('; '));
    }
    assert.equal(module.tools.find((tool) => tool.name === plan.read.tool)?.annotations.readOnlyHint, true, 'the read step is a read tool');
  });
}

for (const vendor of vendors) {
  test(`${vendor}: the README documents its environment variables and tools`, () => {
    const { module } = loadModule(vendor);
    for (const credential of module.credentials) assert.ok(readme.includes(envNameFor(vendor, credential)), envNameFor(vendor, credential));
    for (const tool of module.tools) assert.ok(readme.includes(`\`${tool.name}\``), tool.name);
  });
}
