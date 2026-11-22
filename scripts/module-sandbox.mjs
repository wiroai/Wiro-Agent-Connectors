// Loads a built connector module the strict way: in a fresh VM context that
// has web-standard globals only. There is no require, process, Buffer, console
// or fetch in it, so a module that reaches for any of them fails here instead
// of in a host. The build checks every module with it, and the tests run every
// tool call inside it.

import fs from 'node:fs';
import vm from 'node:vm';

/** Patterns a built module must not contain. */
export const FORBIDDEN = [
  { pattern: /\brequire\s*\(/, why: 'require() of a package or Node module' },
  { pattern: /\bimport\s*\(/, why: 'a dynamic import' },
  { pattern: /\bprocess\s*\./, why: 'the Node process object' },
  { pattern: /\bBuffer\b/, why: 'Node Buffer (use Uint8Array)' },
  { pattern: /\bconsole\s*\./, why: 'console (stdout belongs to the MCP protocol; use ctx.log)' },
  { pattern: /(?<![.\w$])fetch\s*\(/, why: 'a global fetch call (use ctx.fetch)' },
  { pattern: /\bglobalThis\s*\.\s*fetch\b/, why: 'the global fetch (use ctx.fetch)' },
  { pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, why: 'dynamic code' },
  { pattern: /\bXMLHttpRequest\b|\bWebSocket\b/, why: 'a network API other than ctx.fetch' },
];

export function forbiddenIn(code) {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ why }) => why);
}

/** The globals a module may use: web standards that Node 22 and later have. */
function sandboxGlobals() {
  return {
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    atob,
    btoa,
    AbortController,
    AbortSignal,
    Headers,
    Blob,
    DOMException,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
  };
}

/**
 * Runs a built module file in a fresh context and returns its exports, plus
 * the context (tests use it to move the module's clock).
 */
export function loadSandboxed(file) {
  const code = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({ ...sandboxGlobals(), module, exports: module.exports });
  vm.runInContext(code, context, { filename: file });
  return { module: module.exports, context };
}
