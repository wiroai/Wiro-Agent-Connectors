# Google Calendar

Open appointment slots and events on one [Google Calendar](https://calendar.google.com), through the Google Calendar API v3 with a Google Cloud service account: find free slots inside your opening hours, list and read events, book, move and cancel them, and call the rest of the Calendar API for that calendar.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `google-calendar` | [Google Calendar](https://calendar.google.com): free slots inside opening hours from the calendar's busy times, list and read events, create, change and delete events (appointments), and call the rest of the Calendar API on the connected calendar | Service account key and calendar ID | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `google-calendar` | `GOOGLE_CALENDAR_SERVICEACCOUNTJSON`, `GOOGLE_CALENDAR_CALENDARID`; optional `GOOGLE_CALENDAR_TIMEZONE`, `GOOGLE_CALENDAR_SLOTDURATIONMINUTES` | A service account key (the JSON file, or its base64 text) from Google Cloud console, and the ID of a calendar shared with that service account. See below. |

## Credentials

| Credential | Variable | Required | What it is |
| --- | --- | --- | --- |
| `serviceaccountjson` | `GOOGLE_CALENDAR_SERVICEACCOUNTJSON` | yes | The service account key file, as JSON text (or its base64 text). |
| `calendarid` | `GOOGLE_CALENDAR_CALENDARID` | yes | The calendar the connector works on, such as `abc123@group.calendar.google.com`. |
| `timezone` | `GOOGLE_CALENDAR_TIMEZONE` | no | An IANA time zone such as `Europe/Istanbul`, for slots and for times given without an offset. Default: the calendar's own time zone. |
| `slotdurationminutes` | `GOOGLE_CALENDAR_SLOTDURATIONMINUTES` | no | The default appointment length in minutes, such as `30`, `45` or `60`. Default: 30. |

### Service account key (`serviceaccountjson`)

1. Open [Google Cloud console](https://console.cloud.google.com/) and pick or create a project.
2. Go to **APIs & Services → Library**, search for **Google Calendar API** and click **Enable**.
3. Go to **IAM & Admin → Service accounts → Create service account**, give it a name, click **Create and continue**, then **Done**. It needs no project role.
4. Open the new service account, go to **Keys → Add key → Create new key**, choose **JSON** and click **Create**. A JSON file downloads: its whole text is the credential.
5. Note the service account's email, such as `booking@your-project.iam.gserviceaccount.com`: you share the calendar with it.

If Google Cloud refuses to create a key because of the organization policy `iam.disableServiceAccountKeyCreation`, an administrator of your organization has to allow keys for this project.

To revoke it: in Google Cloud console go to **IAM & Admin → Service accounts**, open the service account, and delete the key under **Keys** (or disable or delete the whole service account). The connector stops working at once.

### Calendar ID (`calendarid`)

1. In [Google Calendar](https://calendar.google.com), click the gear icon → **Settings**, and pick the calendar under **Settings for my calendars**.
2. Under **Share with specific people or groups**, click **Add people and groups**, paste the service account's email, choose **Make changes to events**, and click **Send**.
3. On the same page, under **Integrate calendar**, copy the **Calendar ID**. `primary` would be the service account's own calendar, which nobody else sees.

To revoke access: remove the service account under **Share with specific people or groups**.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_calendar` | read | The connected calendar: name, description and time zone, with the connection's time zone and slot length. A quick check that the key works and the calendar is shared. |
| `find_free_slots` | read | Free slots of a given length (default: the connection's slot length) inside opening hours (default Monday to Friday 09:00 to 18:00), from the calendar's busy times, with buffers, minimum notice and the busy blocks. Up to 62 days per call, with a cursor. |
| `list_events` | read | Events from a time on, in start order, repeating events expanded, filtered by text or change time, with a cursor. |
| `get_event` | read | One event with its guests, reminders, status and link. |
| `create_event` | create | Books an event: title, start and end (or a duration), description, location, reminders, repeat rules, color, visibility and private tags. It picks the event's id itself, so an unclear outcome can be checked with `get_event`. Guests are not taken (see Limits). |
| `update_event` | update | Changes the fields given: times, title, description, location, reminders, status (cancelled cancels it). Guests added in Google Calendar stay. |
| `delete_event` | delete | Deletes an event (a whole series for a repeating event); an event already deleted counts as deleted. |
| `api_get` | read | Any other GET of the Calendar API under `/calendar/v3/`, such as event instances, the calendar's sharing (`acl`) or colors. Calendar paths must name the connected calendar; the service account's calendar list is reachable for that calendar's entry only. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/calendar/v3/`, such as `events/quickAdd` or sharing changes, on the connected calendar only: creating calendars, moving events to another calendar and free/busy queries of other calendars are left out. Sent once, never retried. |

## Limits

- The connector works on the one calendar of the connection; the generic tools refuse paths, moves and free/busy queries that name another calendar.
- Guests are not supported: Google Calendar refuses guests from a service account unless it acts as a Google Workspace user through domain-wide delegation, which this connection does not do. Add guests in Google Calendar itself; `send_updates` then decides who hears about a change.
- `find_free_slots` searches at most 62 days per call and returns up to 200 slots per page.
- The access token is kept in memory until 5 minutes before it expires; the key itself is never stored or logged.
- Google Calendar API quotas apply per project and per user per minute. Google Calendar reports most of them as HTTP 403 (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`): the error then says it is a usage limit; wait a minute and try again. An HTTP 429 comes with `retryAfter` when Google sends a wait time.
