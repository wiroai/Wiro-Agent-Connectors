import { base64Decode, googleServiceAccountToken, utf8Decode, type ApiRequest, type ApiResponse, type ToolHelpers } from '../../core/index.js';

// The service account key: the JSON file Google Cloud creates for the key, as
// text. A value that is not JSON itself is read as base64 (how some setups
// keep the uploaded file, optionally as a data: URL); anything else goes on
// as given, so the core says what is wrong with it. The key is never logged,
// returned or quoted.

export const KEY_CREDENTIAL = 'serviceaccountjson';

/** The key file's JSON text, from the value itself or from its base64 text. */
export function keyFileText(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.startsWith('{')) return text;
  const raw = text.replace(/^data:[^,]*;base64,/i, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const decoded = utf8Decode(base64Decode(raw)).trim();
    if (decoded.startsWith('{')) return decoded;
  } catch {
    // not base64 either: the core explains what a key file looks like
  }
  return text;
}

/** The service account's email, for messages such as "share it with ...", or undefined. */
export function serviceAccountEmail(h: ToolHelpers): string | undefined {
  try {
    const data: unknown = JSON.parse(keyFileText(h.credentials[KEY_CREDENTIAL]));
    const email = (data as { client_email?: unknown } | null)?.client_email;
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

/** "the service account (name@project.iam.gserviceaccount.com)", or "the service account". */
export function serviceAccountWords(h: ToolHelpers): string {
  const email = serviceAccountEmail(h);
  return email ? `the service account ${email}` : 'the service account';
}

/** One API request with a token from the service account key (kept in memory until shortly before it expires). */
export async function googleApi(h: ToolHelpers, scopes: string[], request: ApiRequest): Promise<ApiResponse> {
  const token = await googleServiceAccountToken(h, keyFileText(h.credentials[KEY_CREDENTIAL]), { scopes });
  return h.api({ ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } });
}
