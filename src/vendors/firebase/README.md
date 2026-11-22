# Firebase

Push notifications with [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging), through the FCM HTTP v1 API with the service account of each Firebase project: send to a topic, a condition of topics or one device, with an image, data for the app and Android and iOS options; have Firebase validate a message first; and work with several Firebase projects in one connection, each with its apps and topics.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `firebase` | [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging): push notifications to topics, topic conditions or one device, with images, data and Android and iOS options; validation without delivery; several projects with their apps and topics | Service account key per project | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `firebase` | `FIREBASE_ACCOUNTS` | The service account key file of a Firebase project (Firebase console → Project settings → Service accounts), or a JSON list of projects with their keys, apps and topics. See below. |

## Credentials

| Credential | Variable | Required | What it is |
| --- | --- | --- | --- |
| `accounts` | `FIREBASE_ACCOUNTS` | yes | The connected projects: one service account key file, or a JSON list of projects. JSON text or its base64 text. |

### Service account keys (`accounts`)

For each Firebase project:

1. Open the [Firebase console](https://console.firebase.google.com/), pick the project, click the gear icon → **Project settings → Service accounts**.
2. Under **Firebase Admin SDK**, click **Generate new private key**, then **Generate key**. A JSON file downloads. Its service account (`firebase-adminsdk-...@<project>.iam.gserviceaccount.com`) already has the role FCM needs.
3. Check that **Project settings → Cloud Messaging → Firebase Cloud Messaging API (V1)** shows **Enabled**.

With one project, the key file's text is the whole credential. With several, or to tell the agent about the project's apps and the topics they subscribe users to, give a list:

```json
[
  {
    "appname": "My App",
    "serviceaccountjson": { "type": "service_account", "project_id": "my-app", "client_email": "...", "private_key": "..." },
    "apps": [{ "platform": "android", "id": "com.example.app" }, { "platform": "ios", "id": "1234567890" }],
    "topics": [{ "topickey": "locale_en", "topicdesc": "English speaking users" }]
  }
]
```

`serviceaccountjson` may also be the key file's JSON text or base64 text, and camelCase names (`appName`, `topicKey`, `topicDesc`) work too. The project id comes from the key file. Topics are the names your app passes to `subscribeToTopic`; with none, send to a device token or to a topic every install subscribes to.

To revoke a key: in [Google Cloud console](https://console.cloud.google.com/) pick the project, go to **IAM & Admin → Service accounts**, open the `firebase-adminsdk` account, and delete the key under **Keys**. The connector can no longer send for that project.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_projects` | read | The connected projects from the settings, without calling Firebase: project id, app name, service account, apps and topics with their audiences. |
| `check_projects` | read | Signs in to every project and has Firebase validate a test message without delivering it; names the first project that fails and why. |
| `validate_message` | read | Has Firebase check a message (the same arguments as `send_message`) without delivering it, and shows it as it would be sent. |
| `send_message` | create | Sends a push to a topic, a condition of up to 5 topics, or one device token: title, text, image, data, Android channel, click action, sound, iOS badge, priority, time to live, collapse key, analytics label, and raw Android, iOS and web options. Returns the message id. |

## Limits

- Firebase delivers a message at once and keeps no list of sent messages: a send whose outcome is unknown cannot be checked afterwards, and sending it again may notify users twice.
- Data is text only, up to 4 KB; a condition combines at most 5 topics.
- Firebase allows 600,000 messages per minute per project by default, and 240 messages per minute and 5,000 per hour to one Android device.
- An image shows on iOS only when the app has a Notification Service Extension.
- Topic subscriptions are managed by the app itself; the connector sends to topics but does not subscribe devices to them.
- Each project's access token is kept in memory until 5 minutes before it expires; the keys themselves are never stored or logged.
