# Kaggle connector

Your own [Kaggle](https://www.kaggle.com) account through the Kaggle API v1 (`https://www.kaggle.com/api/v1/`, documented with the [Kaggle CLI](https://github.com/Kaggle/kaggle-cli)): your notebooks and datasets, notebooks pushed and run on CPU, GPU or TPU, run status, logs and output files, datasets and new versions from files, your GPU and TPU quota, and competitions, leaderboards and submissions. Everything is created private unless asked otherwise.

| | |
| --- | --- |
| What it can do | List and read notebooks, push and run them on CPU, GPU or TPU, check runs and read their logs and output files, create datasets and versions, quota, competitions, leaderboards and submissions |
| Auth | Your Kaggle username and an API token |
| Environment variables | `KAGGLE_USERNAME`, `KAGGLE_APITOKEN` |
| Where to get them | The username is the last part of your profile address; the token comes from Kaggle → Settings → API → Generate New Token |

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `username` | `KAGGLE_USERNAME` | Yes |
| `apitoken` | `KAGGLE_APITOKEN` | Yes |

The token goes only to `https://www.kaggle.com/api/v1/`, as `Authorization: Bearer <token>`. The username names your notebooks and datasets (`janedoe/sales-forecast`) when only a slug is given.

### The username

1. Sign in at [kaggle.com](https://www.kaggle.com) and open your profile page (your picture, top right).
2. The username is the last part of that page's address: in `https://www.kaggle.com/janedoe` it is `janedoe`. A leading `@` or the whole profile address is accepted too.

### The API token

1. Open [Settings → API](https://www.kaggle.com/settings/api) (your picture, top right, then **Settings**, then the **API** section).
2. Click **Generate New Token**, then **Copy**. A token is `KGAT_` followed by 32 hexadecimal characters.

An older key from **Create Legacy API Key** (the 32-character `key` inside a `kaggle.json` file) also works: it is sent with the username, as Kaggle's own client does.

### How to revoke it

Go back to **Settings → API** on Kaggle and remove the token (or expire the legacy key). The connector stops reaching Kaggle until a new token is given.

## Tools

Notebooks and datasets are named `owner/slug`, by their slug alone for your own, or by their kaggle.com link; competitions by their slug or link.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_quota` | read | The weekly GPU and TPU hours: used, held by running sessions, left, the weekly total and when it refreshes. |
| `list_notebooks` | read | Your notebooks (or someone's public ones), last run first, with language, type, visibility, accelerator, internet, votes and version. |
| `get_notebook` | read | One notebook's settings and data sources, and its code in windows with a cursor. |
| `push_notebook` | create | Creates a notebook or saves a new version, and runs it unless asked not to: private, CPU and no internet by default; a T4 or L4 GPU or a TPU v5e-8 on request. |
| `get_notebook_status` | read | The latest run's status (queued, running, complete, error, cancelled) and Kaggle's failure message. |
| `get_notebook_output` | read | The latest run's output files with their signed download links, and the last lines of its log. |
| `read_notebook_output_file` | read | A text output file's contents (a results CSV, a JSON file), in windows with a cursor; up to 8 MB. |
| `list_datasets` | read | Your datasets (or public ones, or one user's), last updated first, with size, visibility, downloads, votes, version and usability. |
| `list_dataset_files` | read | A dataset's files with their sizes and dates. |
| `get_dataset_status` | read | Whether a dataset is still processing or ready. |
| `create_dataset` | create | Creates a dataset from files given by public https URL or as text, private unless asked; a public one needs a license. The slug takes 6 to 50 lowercase letters, digits and dashes. |
| `create_dataset_version` | write | Uploads a new version from files: send every file the dataset should keep. With `delete_old_versions` it also deletes every earlier version for good, so it is marked destructive. |
| `list_competitions` | read | Competitions by words, category or group (the main list, the ones you entered, community competitions or the ones you host), with reward, deadline, teams and whether they take notebook submissions only. |
| `get_leaderboard` | read | The top of a competition's public leaderboard. |
| `list_submissions` | read | Your submissions to a competition with their status and scores. |
| `submit_to_competition` | create | Submits a file (by public https URL or as text) to a competition you joined; it uses one of the day's submissions. |
| `submit_notebook_to_competition` | create | Submits a notebook version and its output file to a code competition. |
| `api_get` | read | Any other GET of the Kaggle API under `/api/v1/`, such as dataset metadata, competition data files or models. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the Kaggle API under `/api/v1/`. Sent once, never retried. Deleting notebooks, datasets or models is not offered: a path with a delete segment, in any case, is refused. |

### How files are uploaded

Kaggle takes files in three steps: an upload ticket from Kaggle, the file sent to the signed address the ticket names, then the dataset or submission call that names the ticket's token. The connector downloads each file from its public https URL (through the host's guarded fetch) or takes its text, sends it to the signed address on Google Cloud Storage (`storage.googleapis.com` or `www.googleapis.com`) without the Kaggle token, and refuses an address anywhere else. Those two origins are declared next to Kaggle's for that reason only.

## Limits

- Files to upload: 25 MB each (the most a host downloads), up to 20 per call, from a public https URL or as text up to 1,000,000 characters. A file hosted on one of the two Google Cloud Storage origins is fetched as an API reply, which hosts may cap lower (8 MB in the stdio CLI). Kaggle itself takes up to 200 GB per dataset and 200 GB of private datasets in all, at most 50 files at the top level; bigger files go up with Kaggle's own tools.
- A run lasts up to 12 hours on CPU and GPU, 9 on TPU, and writes up to 20 GB to `/kaggle/working`. GPU and TPU hours come from the weekly quota; GPU and internet need a phone-verified account.
- Competition submissions count against each competition's daily limit; you must join a competition and accept its rules on kaggle.com first.
- Kaggle limits request rates on its own; a `429` comes back with `retryAfter` when Kaggle gives one, and nothing is retried. A write without a clear answer is reported as unknown, with the read tool to check.
- Nothing is deleted through the connector: delete notebooks and datasets on kaggle.com.
