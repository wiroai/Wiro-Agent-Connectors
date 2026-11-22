// In-app event images. The image is downloaded from a public https URL and
// checked from its own bytes (JPEG or PNG, Apple's sizes) before anything is
// written; then App Store Connect reserves it, it is uploaded in the parts
// Apple names, the upload is committed, and the tool follows Apple's
// processing until it is done.
//
// The parts go to the upload addresses App Store Connect returns
// (pre-signed, time-limited, on Apple's upload servers under
// blobstore.apple.com or at northamerica-1.object-storage.apple.com, which
// change per upload), not to the API's own origin.
// They are sent through ctx.fetch with PUT, Apple's request headers and no
// credentials. The module declares those servers in uploadHosts, so hosts let
// the upload through; a host that still refuses it does so before anything is
// sent, and the tool then removes the reservation again.

import { cleanVendorText, isUploadHost, OutcomeUnknown, ToolFailure, type ToolHelpers } from '../../core/index.js';
import { compact, sleep, trimEventImage, type Asc } from './client.js';

export const EVENT_ASSET_TYPES = ['EVENT_CARD', 'EVENT_DETAILS_PAGE'] as const;
export type EventAssetType = (typeof EVENT_ASSET_TYPES)[number];

/** The largest image the tool downloads; Apple takes larger files, hosts cap downloads near here. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const POLL_MS = 3000;
const POLL_FOR_MS = 45_000;
/**
 * The hosts of the upload addresses App Store Connect returns: Apple's upload
 * servers, such as store-030.blobstore.apple.com (Apple's "Uploading assets to
 * App Store Connect"), and its object storage at
 * northamerica-1.object-storage.apple.com, the two kinds of HTTP upload host
 * Apple's Transporter lists. The connector's uploadHosts.
 */
export const UPLOAD_HOSTS = ['.blobstore.apple.com', 'northamerica-1.object-storage.apple.com'];
/** The upload hosts in words: *.blobstore.apple.com or northamerica-1.object-storage.apple.com. */
const UPLOAD_SERVERS = UPLOAD_HOSTS.map((host) => (host.startsWith('.') ? `*${host}` : host)).join(' or ');
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

interface Spec {
  name: string;
  min: [number, number];
  max: [number, number];
  ratio: [number, number];
  orientation: string;
}

/** Apple's in-app event media specifications for images. */
const SPECS: Record<EventAssetType, Spec> = {
  EVENT_CARD: { name: 'event card', min: [1920, 1080], max: [3840, 2160], ratio: [16, 9], orientation: 'landscape' },
  EVENT_DETAILS_PAGE: { name: 'event details page', min: [1080, 1920], max: [2160, 3840], ratio: [9, 16], orientation: 'portrait' },
};

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000) + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
}

function u16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** JPEG start-of-frame markers, which carry the size: C0 to CF but C4, C8 and CC. */
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** The format and pixel size of a PNG or JPEG file, read from its bytes; undefined for anything else. */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length >= 24 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    // The first chunk is IHDR: width and height, 4 bytes each.
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined;
    return { format: 'png', width: u32(bytes, 16), height: u32(bytes, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1] as number;
      if (marker === 0xff) {
        at += 1; // fill byte
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        at += 2; // a marker without a length
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return undefined; // the image data starts before any frame header
      const length = u16(bytes, at + 2);
      if (length < 2) return undefined;
      if (isStartOfFrame(marker)) {
        if (at + 9 > bytes.length) return undefined;
        return { format: 'jpeg', width: u16(bytes, at + 7), height: u16(bytes, at + 5) };
      }
      at += 2 + length;
    }
  }
  return undefined;
}

/** Refuses an image App Store Connect would not take for this place, before anything is written. */
export function checkEventImage(info: ImageInfo | undefined, assetType: EventAssetType): ImageInfo {
  const spec = SPECS[assetType];
  const [minWidth, minHeight] = spec.min;
  const [maxWidth, maxHeight] = spec.max;
  const [ratioWidth, ratioHeight] = spec.ratio;
  const needs = `The ${spec.name} image must be a ${spec.orientation} JPEG or PNG with a ${ratioWidth}:${ratioHeight} aspect ratio, `
    + `from ${minWidth}x${minHeight} to ${maxWidth}x${maxHeight} pixels`;
  if (!info) throw new ToolFailure(`The file at image_url is not a JPEG or PNG image. ${needs}. Nothing was changed.`);
  const { width, height } = info;
  if (width * ratioHeight !== height * ratioWidth || width < minWidth || height < minHeight || width > maxWidth || height > maxHeight) {
    throw new ToolFailure(`The image is ${width}x${height} pixels. ${needs}, such as ${minWidth}x${minHeight}: crop or resize it first. Nothing was changed.`);
  }
  return info;
}

const RESERVE_ERRORS = {
  403: "The App Store Connect key's role cannot manage in-app events (it needs Admin, App Manager or Marketing)",
  409: 'App Store Connect refused the image: the localization may already have one of this kind, or the event can no longer be changed in its state',
  422: 'App Store Connect refused the image: a value is invalid',
};
const COMMIT_ERRORS = {
  409: 'App Store Connect refused to finish the upload: the bytes it received do not match the image, or the reservation has expired',
};

/** Why the parts could not be uploaded, as a sentence for the result. */
class UploadProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadProblem';
  }
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (code === 'TIMEOUT' || name === 'TimeoutError') return 'the request timed out';
  if (code === 'ABORTED' || name === 'AbortError') return 'the request was cancelled';
  return 'a network error';
}

/** Sends each part of the image to the upload address App Store Connect gave for it. */
async function uploadParts(h: ToolHelpers, operations: unknown, bytes: Uint8Array): Promise<void> {
  if (!Array.isArray(operations) || !operations.length) throw new UploadProblem('App Store Connect returned no upload address for the image.');
  const parts = operations.map((operation: any, index) => {
    const which = `part ${index + 1} of ${operations.length}`;
    const offset = operation?.offset;
    const length = operation?.length;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset + length > bytes.length) {
      throw new UploadProblem(`App Store Connect asked for ${which} at a place the image does not have.`);
    }
    if (String(operation?.method ?? 'PUT').toUpperCase() !== 'PUT') throw new UploadProblem(`App Store Connect asked to upload ${which} with a method other than PUT.`);
    let url: URL | undefined;
    try {
      url = new URL(String(operation?.url));
    } catch {
      // refused below
    }
    if (!url || url.protocol !== 'https:' || !isUploadHost(url.hostname, UPLOAD_HOSTS) || url.username || url.password) {
      throw new UploadProblem(`App Store Connect returned an upload address for ${which} that is not an https address on its upload servers (${UPLOAD_SERVERS}).`);
    }
    const headers: Record<string, string> = {};
    for (const header of Array.isArray(operation?.requestHeaders) ? operation.requestHeaders : []) {
      if (typeof header?.name === 'string' && HEADER_NAME.test(header.name) && typeof header?.value === 'string') headers[header.name] = header.value;
    }
    return { which, url: url.toString(), headers, offset: offset as number, length: length as number };
  });
  for (const part of parts) {
    const started = Date.now();
    let response: Response;
    try {
      response = await h.ctx.fetch(part.url, {
        method: 'PUT',
        headers: part.headers,
        body: bytes.slice(part.offset, part.offset + part.length),
        ...(h.ctx.signal ? { signal: h.ctx.signal } : {}),
      });
    } catch (error) {
      h.log(`apple-appstore ${h.tool} PUT failed ${Date.now() - started}ms`);
      if ((error as { code?: unknown } | null)?.code === 'URL_REFUSED') {
        const reason = cleanVendorText((error as { message?: unknown } | null)?.message, 200);
        throw new UploadProblem(`The host running this connector refused to send ${part.which} to App Store Connect's upload server${reason ? ` (${reason})` : ''}, so the image was not sent.`);
      }
      throw new UploadProblem(`The upload of ${part.which} to App Store Connect's upload server failed (${describe(error)}).`);
    }
    h.log(`apple-appstore ${h.tool} PUT ${response.status} ${Date.now() - started}ms`);
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new UploadProblem(`App Store Connect's upload server answered HTTP ${response.status} for ${part.which}.`);
  }
}

/** Removes a reservation the upload could not finish, and says how that went. */
async function removeReservation(api: Asc, id: string): Promise<string> {
  try {
    await api.send({ method: 'DELETE', path: `/v1/appEventScreenshots/${encodeURIComponent(id)}` });
    return `The reserved image ${id} was removed again, so nothing was left behind.`;
  } catch {
    return `The reserved image ${id} could not be removed: delete it with delete_app_event_image before trying again.`;
  }
}

/** Where a person adds an event image in App Store Connect. */
const IN_APP_STORE_CONNECT = 'Or add the image in App Store Connect (Apps > the app > In-App Events > the event, in its locale).';

/** Reads the image until App Store Connect has processed it, for a while. */
async function waitProcessed(h: ToolHelpers, api: Asc, id: string): Promise<any> {
  const until = Date.now() + POLL_FOR_MS;
  for (;;) {
    const reply = await api.get(`/v1/appEventScreenshots/${encodeURIComponent(id)}`, {
      'fields[appEventScreenshots]': 'fileName,fileSize,appEventAssetType,assetDeliveryState,imageAsset',
    });
    const state = reply?.data?.attributes?.assetDeliveryState?.state;
    if (state === 'COMPLETE' || state === 'FAILED' || Date.now() + POLL_MS > until) return reply?.data;
    await sleep(POLL_MS, h.ctx.signal);
  }
}

/**
 * Reserves, uploads and commits one in-app event image, then follows its
 * processing. The reservation is the change: an unclear answer to it is an
 * unknown outcome; a failure after it removes the reservation again.
 */
export async function uploadEventImage(
  h: ToolHelpers,
  api: Asc,
  args: { localizationId: string; assetType: EventAssetType; bytes: Uint8Array; info: ImageInfo },
): Promise<Record<string, unknown>> {
  const { localizationId, assetType, bytes, info } = args;
  const fileName = `${assetType === 'EVENT_CARD' ? 'event-card' : 'event-details-page'}.${info.format === 'png' ? 'png' : 'jpg'}`;
  const { data } = await api.send({
    method: 'POST',
    path: '/v1/appEventScreenshots',
    json: {
      data: {
        type: 'appEventScreenshots',
        attributes: { fileName, fileSize: bytes.length, appEventAssetType: assetType },
        relationships: { appEventLocalization: { data: { type: 'appEventLocalizations', id: localizationId } } },
      },
    },
    write: true,
    errors: RESERVE_ERRORS,
  });
  const id = data?.data?.id;
  if (typeof id !== 'string' || !id) throw new OutcomeUnknown('App Store Connect answered without the id of the reserved image, so it is not known whether one was reserved.');

  try {
    await uploadParts(h, data?.data?.attributes?.uploadOperations, bytes);
  } catch (error) {
    if (!(error instanceof UploadProblem)) throw error;
    throw new ToolFailure(`${error.message} ${await removeReservation(api, id)} ${IN_APP_STORE_CONNECT}`);
  }

  try {
    await api.send({
      method: 'PATCH',
      path: `/v1/appEventScreenshots/${encodeURIComponent(id)}`,
      json: { data: { type: 'appEventScreenshots', id, attributes: { uploaded: true } } },
      write: true,
      errors: COMMIT_ERRORS,
    });
  } catch (error) {
    if (!(error instanceof ToolFailure)) throw error;
    // The failure says "Nothing was changed", which is not so after the reservation: say what was.
    throw new ToolFailure(`${error.message.replace(/ Nothing was changed\./, '')} ${await removeReservation(api, id)} ${IN_APP_STORE_CONNECT}`, error.details);
  }

  let image: any;
  try {
    image = await waitProcessed(h, api, id);
  } catch (error) {
    if (!(error instanceof ToolFailure)) throw error;
    return compact({
      localizationId,
      image: { id, assetType, fileName, fileSize: bytes.length, state: 'UPLOAD_COMPLETE' },
      note: `The image was uploaded, but its processing could not be followed (${error.message.replace(/ Nothing was changed\./, '').replace(/[.!?]+$/u, '')}). Check it with list_app_event_images.`,
    });
  }
  const trimmed = trimEventImage(image ?? { id });
  if (trimmed['state'] === 'FAILED') {
    const reasons = Array.isArray(trimmed['errors']) && trimmed['errors'].length
      ? `: ${(trimmed['errors'] as string[]).map((reason) => reason.replace(/[.!?]+$/u, '')).join('; ')}`
      : '';
    throw new ToolFailure(`App Store Connect could not process the image${reasons}. ${await removeReservation(api, id)}`);
  }
  return compact({
    localizationId,
    image: trimmed,
    note: trimmed['state'] === 'COMPLETE'
      ? undefined
      : 'App Store Connect is still processing the image (it can take a few minutes): check it with list_app_event_images.',
  });
}
