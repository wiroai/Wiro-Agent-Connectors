// Sending an in-app event to App Review: App Store Connect reviews items in a
// review submission of the app. The tool reuses the app's open submission
// when it holds nothing else (or already holds the event), creates one
// otherwise, adds the event and sends the submission. A submission that holds
// anything besides the event (an app version, another event) is left alone:
// sending it would send those too.

import { ToolFailure, truncate } from '../../core/index.js';
import { appEventOf, compact, includedMap, type Asc } from './client.js';

export const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'];
/** The event states App Review takes an event in. */
const SUBMITTABLE = new Set(['DRAFT', 'READY_FOR_REVIEW', 'REJECTED']);
/** How many of the app's open submissions are looked into for the event. */
const MAX_OPEN = 3;

const CREATE_ERRORS = {
  403: "The App Store Connect key's role cannot send items to App Review (it needs Admin, App Manager or Marketing)",
  409: 'App Store Connect refused to start a review submission: the app may already have one waiting for or in review on this platform. Send the event once that review is done, or add it in App Store Connect',
};
const ITEM_ERRORS = {
  403: "The App Store Connect key's role cannot send items to App Review (it needs Admin, App Manager or Marketing)",
  409: 'App Store Connect refused to add the event: an event needs its texts and both images (event card and event details page) in its locales, and must not be in another submission',
  422: 'App Store Connect refused to add the event',
};
const SUBMIT_ERRORS = {
  403: "The App Store Connect key's role cannot send items to App Review (it needs Admin, App Manager or Marketing)",
  409: 'App Store Connect refused to send the submission: an item in it is not complete, or the submission can no longer be sent',
};

interface Content {
  hasEvent: boolean;
  /** What else the submission holds, in words. */
  others: string[];
}

/** What an open submission holds besides the event. Removed items do not count. */
async function contentOf(api: Asc, submissionId: string, eventId: string): Promise<Content> {
  const data = await api.get(`/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items`, {
    include: 'appEvent,appStoreVersion',
    'fields[reviewSubmissionItems]': 'state,appEvent,appStoreVersion',
    'fields[appEvents]': 'referenceName',
    'fields[appStoreVersions]': 'versionString,platform',
    limit: 50,
  });
  const events = includedMap(data, 'appEvents');
  const versions = includedMap(data, 'appStoreVersions');
  let hasEvent = false;
  const others: string[] = [];
  for (const item of Array.isArray(data?.data) ? data.data : []) {
    if (item?.attributes?.state === 'REMOVED') continue;
    const eventRef = item?.relationships?.appEvent?.data?.id;
    const versionRef = item?.relationships?.appStoreVersion?.data?.id;
    if (eventRef === eventId) hasEvent = true;
    else if (typeof eventRef === 'string') others.push(`the in-app event ${truncate(String(events.get(eventRef)?.attributes?.referenceName ?? eventRef), 80)}`);
    else if (typeof versionRef === 'string') others.push(`app version ${truncate(String(versions.get(versionRef)?.attributes?.versionString ?? versionRef), 40)}`);
    else others.push('an item that is not an in-app event');
  }
  return { hasEvent, others };
}

/** Takes "Nothing was changed." off a failure that comes after an earlier step changed something, and says what was. */
function after(error: unknown, sentence: string): never {
  if (error instanceof ToolFailure) throw new ToolFailure(`${error.message.replace(/ Nothing was changed\./, '')} ${sentence}`, error.details);
  throw error;
}

export async function submitEventForReview(
  api: Asc,
  args: { app_id: string; event_id: string; platform: string },
): Promise<Record<string, unknown>> {
  const { app_id: appId, event_id: eventId, platform } = args;
  const event = await appEventOf(api, appId, eventId, 'referenceName,eventState');
  const state = event?.attributes?.eventState;
  if (typeof state === 'string' && !SUBMITTABLE.has(state)) {
    throw new ToolFailure(`The in-app event ${eventId} is ${state}: only a draft, a rejected event or one ready for review can be sent to App Review. Nothing was sent.`);
  }

  const open = await api.get('/v1/reviewSubmissions', {
    'filter[app]': appId,
    'filter[platform]': platform,
    'filter[state]': 'READY_FOR_REVIEW,UNRESOLVED_ISSUES',
    'fields[reviewSubmissions]': 'platform,state',
    limit: 10,
  });
  const submissions: any[] = (Array.isArray(open?.data) ? open.data : []).filter((item: any) => typeof item?.id === 'string').slice(0, MAX_OPEN);
  let target: { id: string; content: Content } | undefined;
  let draft: { id: string; content: Content } | undefined;
  for (const submission of submissions) {
    const content = await contentOf(api, submission.id, eventId);
    if (content.hasEvent) {
      target = { id: submission.id, content };
      break;
    }
    if (!draft && submission?.attributes?.state === 'READY_FOR_REVIEW') draft = { id: submission.id, content };
  }
  target ??= draft;
  if (target?.content.others.length) {
    throw new ToolFailure(
      `App ${appId} has an open review submission (${target.id}) that also holds ${target.content.others.slice(0, 5).join(', ')}`
        + `${target.content.others.length > 5 ? ` and ${target.content.others.length - 5} more` : ''}: sending it would send those to App Review too. `
        + 'Send the event in App Store Connect, or take the other items out of that submission first. Nothing was sent.',
    );
  }

  let submissionId = target?.id;
  const created = !submissionId;
  if (!submissionId) {
    const { data } = await api.send({
      method: 'POST',
      path: '/v1/reviewSubmissions',
      json: { data: { type: 'reviewSubmissions', attributes: { platform }, relationships: { app: { data: { type: 'apps', id: appId } } } } },
      write: true,
      errors: CREATE_ERRORS,
    });
    submissionId = data?.data?.id;
    if (typeof submissionId !== 'string' || !submissionId) {
      throw new ToolFailure('App Store Connect started a review submission but did not say its id. Check the app\'s review submissions in App Store Connect before trying again.');
    }
  }

  if (!target?.content.hasEvent) {
    try {
      await api.send({
        method: 'POST',
        path: '/v1/reviewSubmissionItems',
        json: {
          data: {
            type: 'reviewSubmissionItems',
            relationships: {
              reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
              appEvent: { data: { type: 'appEvents', id: eventId } },
            },
          },
        },
        write: true,
        errors: ITEM_ERRORS,
      });
    } catch (error) {
      after(error, created
        ? `The review submission ${submissionId} started for it stays open and empty; the next call reuses it.`
        : `The open review submission ${submissionId} was not changed.`);
    }
  }

  let reply: any;
  try {
    ({ data: reply } = await api.send({
      method: 'PATCH',
      path: `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`,
      json: { data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } },
      write: true,
      errors: SUBMIT_ERRORS,
    }));
  } catch (error) {
    after(error, `The event is in review submission ${submissionId}, which was not sent: fix what App Store Connect names, then call submit_app_event_for_review again, or send it in App Store Connect.`);
  }
  const attributes = reply?.data?.attributes ?? {};
  return compact({
    appId,
    eventId,
    referenceName: event?.attributes?.referenceName,
    submission: compact({ id: submissionId, platform: attributes.platform ?? platform, state: attributes.state, submittedDate: attributes.submittedDate }),
    reusedSubmission: created ? undefined : true,
    note: 'App Review usually answers within a day or two; list_app_events shows the event\'s state.',
  });
}
