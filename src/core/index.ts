// The shared runtime every connector module bundles. Import it from a module's
// index.ts; the build inlines it, so the built module has no dependencies.

export { apiTools } from './api-tools.js';
export type { ApiAccountRule, ApiToolRequest, ApiToolsOptions, ApiWriteMethod } from './api-tools.js';
export { defineConnector, VENDOR_PATTERN } from './connector.js';
export type { ConnectorDefinition, ToolDefinition, ToolHelpers, ToolKind } from './connector.js';
export type { AccountPicker } from '../types.js';
export { andList, orList, requiredAlternatives, unmetAlternatives } from './credentials.js';
export { OutcomeUnknown, ToolFailure } from './errors.js';
export type { FailureDetails } from './errors.js';
export { MAX_API_RESPONSE_BYTES, readCapped, retryAfterSeconds, vendorCode, vendorMessage } from './http.js';
export { appStoreConnectToken, GOOGLE_TOKEN_URL, googleServiceAccountToken, signJwt } from './jwt.js';
export type { AppStoreConnectKey, GoogleServiceAccountOptions, JwtAlgorithm, SignJwtOptions } from './jwt.js';
export type { ApiRequest, ApiResponse, HttpMethod, MediaOptions, MediaResult, QueryValue } from './http.js';
export { parseSiteUrl, siteOrigin } from './origins.js';
export type { SiteUrl } from './origins.js';
export { decodeCursor, encodeCursor, fitPage, jsonSize, OUTPUT_LIMIT_BYTES, shrinkToFit } from './output.js';
export type { PageInput } from './output.js';
export { allowedAccounts, requireAccounts } from './accounts.js';
export { validateArguments } from './schema.js';
export {
  base64Decode,
  base64UrlDecode,
  base64UrlEncode,
  cleanVendorText,
  formatNumber,
  sha256Hex,
  truncate,
  utf8Bytes,
  utf8Decode,
  utf8Length,
} from './text.js';
