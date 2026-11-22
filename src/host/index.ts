// The host side of the package: what a program needs to run connector modules
// itself, and what the stdio CLI is built from.

export { ACCESS_TOKEN_CREDENTIAL, ACCOUNTS_ENV, accountsFromEnv, credentialsFromEnv, envNameFor } from './env.js';
export type { EnvCredentials } from './env.js';
export { ConnectorFetchError, createGuardedFetch, originsFromCredentials } from './guarded-fetch.js';
export type {
  ConnectorFetchErrorCode,
  GuardedFetchOptions,
  MediaReply,
  MediaTransport,
  PinnedReply,
  PinnedTransport,
  ResolvedAddress,
} from './guarded-fetch.js';
export { isPublicAddress } from './ip.js';
// The rule that turns a site or instance URL credential into an origin, for hosts with their own fetch.
export { parseSiteUrl, siteOrigin } from '../core/origins.js';
export type { SiteUrl } from '../core/origins.js';
export { assertConnectorModule, DEFAULT_VENDORS_DIR, listVendors, loadConnector, VENDOR_PATTERN } from './load.js';
export { createConnectorServer, serveStdio } from './server.js';
export type { ConnectorServerOptions } from './server.js';
export type {
  AccountPicker,
  CallToolResult,
  ConnectorAccounts,
  ConnectorFetch,
  ConnectorModule,
  ConnectorRequestInit,
  JsonSchema,
  TextContent,
  ToolAnnotations,
  ToolContext,
  ToolDescriptor,
} from '../types.js';
