// Helpers for connector tests: load a built module in the strict sandbox, give
// it a fake ctx.fetch that records every request, and read its results.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadSandboxed } from '../scripts/module-sandbox.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The built file of a vendor folder: dist/vendors/<vendor>.js, or build/template.js for the template. */
export function builtFile(folder) {
  return folder === '_template' ? path.join(ROOT, 'build', 'template.js') : path.join(ROOT, 'dist', 'vendors', `${folder}.js`);
}

/** Loads a built module in the sandbox: { module, context }. Each load is a fresh instance with fresh state. */
export function loadModule(folder) {
  return loadSandboxed(builtFile(folder));
}

/** Loads the module of the vendor folder the calling test file sits in. */
export function loadModuleFor(importMetaUrl) {
  return loadModule(path.basename(path.dirname(fileURLToPath(importMetaUrl))));
}

/** Reads a JSON fixture next to the calling test file. */
export function fixture(importMetaUrl, name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, importMetaUrl), 'utf8'));
}

/** Makes Date.now() inside a sandboxed module controllable; returns advance(ms). */
export function controlClock(context) {
  vm.runInContext(
    '(() => { const realNow = Date.now.bind(Date); let offset = 0; Date.now = () => realNow() + offset; globalThis.__advanceClock = (ms) => { offset += ms; }; })()',
    context,
  );
  return (ms) => context.__advanceClock(ms);
}

export function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function textResponse(status, text, headers = {}) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

export function bytesResponse(status, bytes, headers = {}) {
  return new Response(bytes, { status, headers });
}

/** An error like a host's refusal: nothing was sent. */
export function refusal(message = 'not an allowed address') {
  return Object.assign(new Error(message), { code: 'URL_REFUSED' });
}

/**
 * A fake ctx.fetch. `handler(request)` gets { url, origin, path, query, method,
 * headers (lower-case names), body, json } and returns a Response or throws.
 * Every request is recorded in .calls.
 */
export function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const headers = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value;
    let json;
    if (typeof init.body === 'string') {
      try {
        json = JSON.parse(init.body);
      } catch {
        // not JSON
      }
    }
    const request = {
      url: parsed.toString(),
      origin: parsed.origin,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body: init.body,
      json,
    };
    calls.push(request);
    return handler(request);
  };
  fetch.calls = calls;
  return fetch;
}

/**
 * A tool context with recorded log lines. accounts defaults to {} (a host with
 * nothing selected); files, such as { maxBytes: 1024 }, only when given (a host
 * that takes files).
 */
export function makeContext({ credentials = {}, accounts = {}, fetch, signal, files } = {}) {
  const logs = [];
  const ctx = { credentials, accounts, fetch, log: (line) => logs.push(String(line)) };
  if (signal) ctx.signal = signal;
  if (files) ctx.files = files;
  return { ctx, logs };
}

const ATTACHMENT = 'attachment:///';

/** An embedded resource that carries a file, as the core makes it. */
function isFileBlock(block) {
  const resource = block?.resource;
  return block?.type === 'resource' && Object.keys(block).length === 2
    && typeof resource?.uri === 'string' && resource.uri.startsWith(ATTACHMENT)
    && typeof resource.mimeType === 'string' && typeof resource.blob === 'string'
    && Buffer.from(resource.blob, 'base64').toString('base64') === resource.blob;
}

/**
 * Calls a tool and returns the plain result, its parsed JSON payload, isError,
 * and the files it handed back ({ name, mimeType, bytes }), which follow the
 * one JSON text block as embedded resources.
 */
export async function callTool(module, name, args, ctx) {
  const result = JSON.parse(JSON.stringify(await module.call(name, args, ctx)));
  const [first, ...blocks] = Array.isArray(result.content) ? result.content : [];
  if (first?.type !== 'text' || !blocks.every(isFileBlock) || (result.isError === true && blocks.length)) {
    throw new Error(`unexpected result shape: ${JSON.stringify(result).slice(0, 200)}`);
  }
  const files = blocks.map(({ resource }) => ({
    name: decodeURIComponent(resource.uri.slice(ATTACHMENT.length)),
    mimeType: resource.mimeType,
    bytes: new Uint8Array(Buffer.from(resource.blob, 'base64')),
  }));
  return { result, payload: JSON.parse(first.text), isError: result.isError === true, text: first.text, files };
}

/** UTF-8 size of a result's text. */
export function textBytes(result) {
  return Buffer.byteLength(result.content[0].text, 'utf8');
}
