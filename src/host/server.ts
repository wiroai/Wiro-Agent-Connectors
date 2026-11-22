import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ConnectorAccounts, ConnectorFetch, ConnectorModule } from '../types.js';
import { createGuardedFetch, originsFromCredentials } from './guarded-fetch.js';

export interface ConnectorServerOptions {
  credentials: Record<string, string>;
  accounts: ConnectorAccounts;
  /** Defaults to a guarded fetch locked to the module's origins, the origins of its originFields credentials and its upload hosts. */
  fetch?: ConnectorFetch;
  /** Where log lines go (default: stderr). Never stdout: that is the protocol. */
  log?: (text: string) => void;
  /** Answer for a credential the host knows is missing, e.g. naming the environment variable. */
  missingCredentials?: string;
  version?: string;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * An MCP server for one connector module. The server is named after the
 * vendor, lists the module's tools as they are, and runs every call through
 * module.call with a fresh context.
 */
export function createConnectorServer(module: ConnectorModule, options: ConnectorServerOptions): Server {
  const log = options.log ?? ((text: string) => process.stderr.write(`${text}\n`));
  const fetch = options.fetch ?? createGuardedFetch({
    origins: module.origins,
    credentialOrigins: originsFromCredentials(module, options.credentials),
    // A module built before uploadHosts existed sends no uploads.
    uploadHosts: module.uploadHosts ?? [],
  });
  const server = new Server(
    { name: module.vendor, version: options.version ?? '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: module.tools.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const started = Date.now();
    let result: CallToolResult;
    if (options.missingCredentials) {
      result = errorResult(options.missingCredentials);
    } else {
      try {
        result = await module.call(name, request.params.arguments ?? {}, {
          credentials: { ...options.credentials },
          accounts: options.accounts,
          fetch,
          signal: extra.signal,
          log,
        });
      } catch {
        // A module returns its errors as results; a throw is a bug, and its message stays out of the reply.
        result = errorResult(`${name} failed unexpectedly.`);
      }
    }
    log(`${module.vendor} ${name} ${result.isError ? 'error' : 'ok'} ${Date.now() - started}ms`);
    return { ...result };
  });

  return server;
}

/** Serves one connector module over stdio until stdin closes. */
export async function serveStdio(module: ConnectorModule, options: ConnectorServerOptions): Promise<Server> {
  const server = createConnectorServer(module, options);
  await server.connect(new StdioServerTransport());
  return server;
}
