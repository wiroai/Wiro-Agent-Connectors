# Google Drive

Files in [Google Drive](https://drive.google.com), with Google Sheets and Google Docs, through the Drive API v3, the Sheets API v4 and the Docs API v1 with a Google Cloud service account: list folders and files, read files as text, upload from a URL or from text, create Docs and Sheets, rename, move, trash and share files, read and write sheet ranges, add text to a Doc, and call the rest of the three APIs.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `google-drive` | [Google Drive](https://drive.google.com) with Sheets and Docs: list shared folders and files, read Docs, Sheets and text files as text, upload files from a URL or text (resumable above 5 MB), create Docs and Sheets, rename, move, trash and share files, read, append, overwrite and clear sheet ranges, add text to a Doc, and call the rest of the Drive, Sheets and Docs APIs | Service account key | Available |

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
| `folders` | The folders (or shared drives) the agent may read and write, with their subfolders. | `list_folders`: with no choice made, the folders shared with the service account and the shared drives it is a member of. |

With a choice made, every tool keeps to those folders, their subfolders and the files in them: a file elsewhere is refused after its parent folders are looked up, new files need a `folder_id` inside them, `list_files` without a folder lists the chosen folders, and a raw `query` is not taken.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_folders` | read | The chosen folders, or the folders shared with the service account and its shared drives, or the subfolders of a folder; the `folders` picker's list. |
| `list_files` | read | The files in a folder, newest change first, filtered by name, full text, type (such as `image/*`) or change time, with a cursor. |
| `get_file` | read | A file's details, links (`webViewLink`, `webContentLink`), export formats and sharing. |
| `read_file` | read | A file's text in pages: a Google Doc as Markdown, text or HTML, a Sheet's first sheet as CSV or TSV, Slides as text, and text files up to 4 MB. A binary file returns its links instead. |
| `upload_file` | create | Uploads a file from a public https URL (up to 50 MB) or from text, typed from its bytes; `convert_to` makes it a Google Doc, Sheet or Slides file. Over 5 MB it uses a resumable upload. |
| `create_document` | create | A new Google Doc, empty or from Markdown, plain text or HTML, in one request. |
| `create_spreadsheet` | create | A new Google Sheet, empty or from rows or CSV, in one request. |
| `update_file` | update | Renames a file, changes its description or star, moves it to another folder, or trashes and restores it. |
| `replace_file_content` | update | Replaces a file's content (from a URL or text) and keeps its id and links. |
| `share_file` | create | Shares a file or folder with a person, a group, a domain or anyone with the link, as reader, commenter or writer. |
| `get_spreadsheet` | read | A Google Sheet's title, locale, time zone and sheets (tabs) with their sizes. |
| `read_sheet` | read | The cells of an A1 range, as shown, raw or as formulas, with a cursor for long ranges. |
| `append_rows` | create | Adds rows after a sheet's table. |
| `update_range` | update | Overwrites the cells of a range. |
| `clear_range` | delete | Clears the values of a range. |
| `add_document_text` | create | Inserts text at the end or the start of a Google Doc. |
| `api_get` | read | Any other GET of the Drive API (`/drive/v3/` on `https://www.googleapis.com`), the Sheets API (`/v4/spreadsheets` on `https://sheets.googleapis.com`) or the Docs API (`/v1/documents` on `https://docs.googleapis.com`), within the chosen folders. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the same APIs, such as Sheets or Docs `batchUpdate`, a permission change or a comment, within the chosen folders. Sent once, never retried. |

## Limits

- A service account owns no Drive storage: Google refuses uploads and new files it would own in a My Drive folder with `storageQuotaExceeded`. Use a folder in a shared drive, where the files belong to the drive.
- Files the service account creates belong to it: share them (`share_file`) with the people who need to edit them.
- `read_file` returns text only, up to 4 MB, in pages of about 25 KB. A binary file (an image, a video, a PDF) is not returned: share it publicly (`share_file`, type `anyone`, role `reader`) for another tool to download it from its `webContentLink`.
- Uploads from a URL take files up to 50 MB, or the host's media limit when it is lower (25 MiB in the stdio CLI).
- A Sheet exports its first sheet only as CSV; `read_sheet` reads any sheet.
- The access token is kept in memory until 5 minutes before it expires; the key itself is never stored or logged.
