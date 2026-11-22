# Google Drive

Files in [Google Drive](https://drive.google.com), with Google Sheets and Google Docs, through the Drive API v3, the Sheets API v4 and the Docs API v1 with a Google Cloud service account: list folders and files, read files as text, hand files and PDF or Office exports to the host, upload from a URL or from text, create Docs and Sheets, rename, move, trash and share files (with download links for services that fetch files by URL, a warning when such a link cannot work, and a way to find links left open), read and write sheet ranges, add text to a Doc, and call the rest of the three APIs.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `google-drive` | [Google Drive](https://drive.google.com) with Sheets and Docs: list shared folders and files, read Docs, Sheets and text files as text, hand files and PDF or Office exports of Google files to the host, upload files from a URL or text (resumable above 5 MB), create Docs and Sheets, rename, move, trash and share files (download and export links for services that fetch by URL, with a warning when a link cannot work), find files shared with anyone, read, append, overwrite and clear sheet ranges, add text to a Doc, and call the rest of the Drive, Sheets and Docs APIs | Service account key | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `google-drive` | `GOOGLE_DRIVE_SERVICEACCOUNTJSON` | A service account key (the JSON file, or its base64 text) from Google Cloud console; share each folder with the service account's email. See below. |

## Credentials

| Credential | Variable | Required | What it is |
| --- | --- | --- | --- |
| `serviceaccountjson` | `GOOGLE_DRIVE_SERVICEACCOUNTJSON` | yes | The service account key file, as JSON text (or its base64 text). |

### Service account key (`serviceaccountjson`)

1. Open [Google Cloud console](https://console.cloud.google.com/) and pick or create a project.
2. Go to **APIs & Services → Library** and enable the **Google Drive API**, the **Google Sheets API** and the **Google Docs API**.
3. Go to **IAM & Admin → Service accounts → Create service account**, give it a name, click **Create and continue**, then **Done**. It needs no project role.
4. Open the new service account, go to **Keys → Add key → Create new key**, choose **JSON** and click **Create**. A JSON file downloads: its whole text is the credential.
5. Copy the service account's email, such as `assets@your-project.iam.gserviceaccount.com`, and share with it what the agent may use:
   - a folder in My Drive: right-click it in [Google Drive](https://drive.google.com) → **Share** → paste the email → **Editor** → **Send**;
   - a shared drive (Google Workspace): open it → **Manage members** → add the email as **Content manager**.

If Google Cloud refuses to create a key because of the organization policy `iam.disableServiceAccountKeyCreation`, an administrator of your organization has to allow keys for this project.

To revoke it: in Google Cloud console go to **IAM & Admin → Service accounts**, open the service account, and delete the key under **Keys** (or disable or delete the whole service account). To take back one folder, remove the service account from the folder's sharing or from the shared drive's members.

## Account picker

| Key | What is chosen | Listed by |
| --- | --- | --- |
| `folders` | The folders (or shared drives) the agent may read and write, with their subfolders. | `list_folders`: with no choice made, every folder the service account can reach (folders shared with it, their subfolders and the folders of its shared drives), each labeled with its parent folder's name (`2026 (in Creatives)`), then the shared drives it is a member of. |

With a choice made, every tool keeps to those folders, their subfolders and the files in them: a file elsewhere is refused after its parent folders are looked up, new files need a `folder_id` inside them, `list_files` without a folder lists the chosen folders, and a raw `query` is not taken. The generic tools check the same: the file a path names, every folder a move or a copy goes into (`addParents`, or `parents` in a JSON body, which a copy must give), the spreadsheet a sheet is copied to (`copyTo`), and the folder a file listing's `q` names (`'FOLDER_ID' in parents`, with only `trashed` and `mimeType` terms besides).

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_folders` | read | The chosen folders, or every folder the service account can reach (labeled with its parent folder's name) and its shared drives, or the subfolders of a folder; the `folders` picker's list. |
| `list_files` | read | The files in a folder, newest change first (full-text matches by relevance), filtered by name, full text, type (such as `image/*`), change time, or whether anyone with the link can open them (`shared_with_anyone`, to find links left open), with a cursor. |
| `get_file` | read | A file's details, links (`webViewLink`, `webContentLink`), export formats and sharing. |
| `read_file` | read | A file's text in pages: a Google Doc as Markdown, text or HTML, a Sheet's first sheet as CSV or TSV, Slides as text, and text files up to 4 MB. A binary file returns its details and links instead (`download_file` hands the file itself to the host), with a `warning` when it is too large to download by link (see [Handing a file to another service](#handing-a-file-to-another-service)). |
| `download_file` | read | Hands a stored file (an image, a video, a PDF, an Office file or any other upload) to the host as a file, with its details, after checking its size against the host's file limit (25 MiB in the stdio CLI). A Google Doc, Sheet, Slides file or Drawing goes through `export_file`; a host that takes no files gets a refusal. |
| `export_file` | read | Hands a copy of a Google Doc (pdf, docx, txt), Sheet (pdf, xlsx, csv of its first sheet), Slides file (pdf, pptx, txt, png of its first slide) or Drawing (pdf, png) to the host as a file. Google Drive exports up to 10 MB. |
| `upload_file` | create | Uploads a file from a public https URL (up to 50 MB) or from text, typed from its bytes; `convert_to` makes it a Google Doc, Sheet or Slides file. Over 5 MB it uses a resumable upload. A local file has to be at a public https URL first. |
| `create_document` | create | A new Google Doc, empty or from Markdown, plain text or HTML, in one request. |
| `create_spreadsheet` | create | A new Google Sheet, empty or from rows or CSV, in one request. |
| `update_file` | update | Renames a file, changes its description or star, moves it to another folder, or trashes and restores it. |
| `replace_file_content` | update | Replaces a file's content (from a URL or text) and keeps its id and links. |
| `share_file` | create | Shares a file or folder with a person, a group, a domain or anyone with the link, as reader, commenter or writer. Shared with anyone, the result carries `downloadUrl` (the file itself) or, for a Google Doc, Sheet or Slides file, `exportUrls` by format (`pdf`, `docx`, `xlsx`, `pptx` and more), for a service that downloads files by URL, and a `warning` when a service could not fetch it (downloads off for viewers, or a file over 100 MB). A sharing that a sharing setting forbids is refused with what to do. |
| `unshare_file` | delete | Removes one sharing by its permission id; `anyoneWithLink` takes back a link shared with anyone, in the same run that shared it. |
| `get_spreadsheet` | read | A Google Sheet's title, locale, time zone and sheets (tabs) with their sizes. |
| `read_sheet` | read | The cells of an A1 range, as shown, raw or as formulas, with a cursor for long ranges. |
| `append_rows` | create | Adds rows after a sheet's table. |
| `update_range` | update | Overwrites the cells of a range. |
| `clear_range` | delete | Clears the values of a range. |
| `add_document_text` | create | Inserts text at the end or the start of a Google Doc. |
| `api_get` | read | Any other GET of the Drive API (`/drive/v3/` on `https://www.googleapis.com`), the Sheets API (`/v4/spreadsheets` on `https://sheets.googleapis.com`) or the Docs API (`/v1/documents` on `https://docs.googleapis.com`), within the chosen folders. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the same APIs, such as Sheets or Docs `batchUpdate`, a permission change or a comment, within the chosen folders. Sent once, never retried. |

## Handing a file to another service

`download_file` hands a stored file to the host, and `export_file` a PDF or Office copy of a Google file, where the host takes files: this package's CLI passes it on to its MCP client, and a host that runs an agent may save it where the agent works. A host that takes no files gets a refusal, and this connector cannot read a file from a workspace. A service that downloads files by URL gets the file by link instead, in three steps in one run:

1. `share_file` with `type` `anyone` and `role` `reader`. The result has `downloadUrl` (the file itself) or, for a Google Doc, Sheet or Slides file, `exportUrls` by format (`pdf`, `docx`, `xlsx`, `pptx` and more), and `permissionId` (`anyoneWithLink`).
2. Pass the link to the service that needs the file, such as an ad platform's or a social network's upload from a URL, and wait for its answer.
3. `unshare_file` with `permission_id` `anyoneWithLink`, whether the service took the file or not.

Until step 3, anyone who has the link can open the file: Google Drive cannot make a link for anyone expire on its own (expiry dates are for people and groups only). A scheduled job shares a file right before the service needs it, never when it only proposes a post or a campaign that waits for approval, and notes the file id until step 3 is done. If a run stops in between, the next one removes the links left open: `list_files` with `shared_with_anyone: true` lists the files of a folder (or of the chosen folders) that anyone with the link can open.

When the link cannot work, `share_file` says so:

| Case | What happens |
| --- | --- |
| A Google Workspace sharing setting forbids sharing outside the organization or with anyone with the link, for the whole organization or for one shared drive | `share_file` is refused (Google answers HTTP 400, for example "ACL change not allowed.", or HTTP 403), and the file cannot leave Google Drive by link until an administrator allows it (Admin console: **Apps → Google Workspace → Drive and Docs → Sharing settings**) or a manager of the shared drive does in its settings. |
| The service account may not share the file | In a shared drive it needs the **Content manager** or **Manager** role; elsewhere **Editor** access with **Editors can change permissions and share** on. When Google Drive says it may not, `share_file` sends nothing. |
| The file is over 100 MB | Google Drive does not scan files that large for viruses, and a download by link gets Google's warning page instead of the file: a service that fetches `downloadUrl` gets that page. `share_file` and `read_file` say so in `warning`. Such a file cannot reach a service by link: make it smaller, or hand it over another way. |
| Downloads are turned off for viewers, on the file or for its shared drive | The link opens the file in Google Drive but gives nothing to download. `share_file` still makes the sharing (people can view the file), returns no download link and says why in `warning`. |
| A Google Doc, Sheet or Slides file is needed as PDF or Office file | `exportUrls` work only while the Google file itself is shared with anyone: until `unshare_file`, the link opens the live document, not only its export. `export_file` hands such a copy to the host instead, within Google's 10 MB export limit, and `read_file` reads text formats (Markdown, plain text, HTML, CSV, TSV) up to 4 MB here. |
| The file is on a computer or in a workspace | `upload_file` and `replace_file_content` take a public https URL (up to 50 MB, or the host's media limit when it is lower: 25 MiB in the stdio CLI) or text given in the call, so the file has to be reachable at a public https URL first. |

## Limits

- A service account owns no Drive storage: Google refuses uploads and new files it would own in a My Drive folder with `storageQuotaExceeded`. Use a folder in a shared drive, where the files belong to the drive.
- Files the service account creates belong to it: share them (`share_file`) with the people who need to edit them.
- `read_file` returns text only, up to 4 MB, in pages of about 25 KB. `download_file` and `export_file` hand files to the host instead, within its file limit (25 MiB a call in the stdio CLI), and Google Drive exports up to 10 MB. Other Google files (Forms, Sites, Apps Script projects, Vids, My Maps) have no stored file, and `export_file` makes no copy of them. For a service that downloads by URL, see [Handing a file to another service](#handing-a-file-to-another-service).
- A full-text search (`full_text`, or `fullText` in `query`) comes back by relevance: Google Drive takes no sort order with it, so `order_by` is refused there.
- Google Drive reports usage limits (`rateLimitExceeded`, `userRateLimitExceeded`) as HTTP 403: the error then says it is a usage limit; wait a minute and try again. An HTTP 429 comes with `retryAfter` when Google sends a wait time.
- Uploads from a URL take files up to 50 MB, or the host's media limit when it is lower (25 MiB in the stdio CLI).
- Google Drive reports a sharing it does not allow as HTTP 400 (`invalidSharingRequest`), and does the same when it made a sharing but could not send its notification email. `share_file` reports the second case as done, with a `warning`; when Google's answer does not say which case it is and an email was due, the outcome is unknown and `get_file` shows whether the sharing was made.
- A Sheet exports its first sheet only as CSV; `read_sheet` reads any sheet.
- The access token is kept in memory until 5 minutes before it expires; the key itself is never stored or logged.
