// Preloaded into the CLI under test with `node --import`. It sends every API
// request to the local mock server in MOCK_VENDOR_URL, with the original host
// as the first path segment, so the real CLI, credentials and guarded fetch
// run end to end without touching the network. Only the tests load it.

const target = process.env.MOCK_VENDOR_URL;

if (target) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input));
    const rewritten = new URL(target);
    rewritten.pathname = `/${original.host}${original.pathname}`;
    rewritten.search = original.search;
    return realFetch(rewritten, init);
  };
}
