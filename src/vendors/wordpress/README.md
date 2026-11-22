# WordPress connector (`wordpress`)

Writes and publishes on your own self-hosted [WordPress](https://wordpress.org) site through its REST API: posts and pages saved as drafts, scheduled or published, with HTML bodies, categories, tags and a featured image; files uploaded to the media library from a public URL with alt text; categories and tags looked up or created (never twice); the SEO title, meta description and focus keyword of the Rank Math SEO plugin; and the rest of the site's REST API with `api_get` and `api_request`.

Credential check: `get_site` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `url` | `WORDPRESS_URL` | The site's address, such as `https://example.com`, with its subdirectory when WordPress is installed in one (`https://example.com/blog`). It must be https. |
| `user` | `WORDPRESS_USER` | The login name of the WordPress user the connector acts as. |
| `apppassword` | `WORDPRESS_APPPASSWORD` | An application password of that user (WordPress 5.6 or later). Never the account password. |

All three are required. The connector sends requests to that site only, signed with HTTP Basic auth (user name and application password). The address is a [credential origin](../../../README.md#credential-origins): hosts check it like a media URL (https, public addresses only) and never follow its redirects. Sites hosted on WordPress.com use another API and are not supported.

### The site address

1. Sign in to the WordPress admin and open **Settings → General**.
2. Copy **Site Address (URL)**. If the REST API answers at `<address>/wp-json/`, the address is right. A link pasted with `/wp-admin` or `/wp-json` at the end works too: that part is ignored.

### A user for the connector

1. In the WordPress admin, open **Users → Add New User**.
2. Create a user just for the connector, with the **Author** role (writes and publishes its own posts) or the **Editor** role (also edits other users' posts, pages and categories). Use its login name as `user`.

### An application password

1. Sign in as that user and open **Users → Profile**.
2. Scroll to **Application Passwords**, enter a name (for example `AI agent`), and click **Add New Application Password**.
3. Copy the password WordPress shows (the spaces in it do not matter). It is shown only once.

Application passwords need the site to be served over https. If WordPress answers that it did not see the sign-in (`rest_not_logged_in`), the site's server or a security plugin is dropping the Authorization header: your host can pass it through.

**Revoke it:** **Users → Profile → Application Passwords**, then **Revoke** next to its name (or **Revoke all application passwords**). Requests fail with a 401 at once; deleting the connector's user does the same.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_site` | read | The site (name, tagline, address, time zone), the connected user with its roles and what it may do, and whether the Rank Math SEO plugin's API is there. |
| `list_posts` | read | Posts or pages, newest first, of any status or one: id, status, title, dates, link, editor link, excerpt, categories, tags, featured image. Search words find posts on a topic. |
| `get_post` | read | One post or page with its raw title and HTML content (in parts of about 20 KB for long posts), excerpt, slug, terms, featured image and links. |
| `create_post` | create | A post or page: a draft by default, or published at once, pending review, private, or scheduled at a date. HTML body, excerpt, slug, categories, tags, featured image, author, comments. |
| `update_post` | update | Changes the given fields of a post or page: publish a draft, take a post offline, replace the cover, edit the text. |
| `upload_media` | create | Downloads a file from a public https URL and adds it to the media library with alt text, title, caption and description, optionally attached to a post. Returns its id and URL. |
| `update_media` | update | Changes a media item's alt text, title, caption, description or attachment. |
| `list_media` | read | The media library, newest first, by search words or type: id, title, URL, type, alt text, pixel size and file size. |
| `list_terms` | read | Categories or tags with ids, names, slugs, post counts and parents. |
| `create_term` | create | A category or tag; when one with that name or slug exists, returns it with `existing: true` instead of making a second. |
| `set_seo_meta` | update | The SEO title, meta description and focus keyword of a post or page through the Rank Math SEO plugin's own endpoint; `applied: false` when the site does not run it. |
| `api_get` | read | Any other GET of the site's REST API, by route after `/wp-json`, such as `/wp/v2/comments` or `/wp/v2/posts/12/revisions`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to a REST route, with a JSON body, such as a comment reply or moving a post to the trash. Sent once, never retried. |

## Limits

- What each call may do follows the user's role: an Author edits only their own posts, an Editor any post, page or category.
- Uploads take JPEG, PNG, GIF, WebP, AVIF or HEIC images, MP4, MOV, WebM or MKV video, MP3, WAV or OGG audio, and PDF, told apart by their bytes; the file is downloaded first (up to 50 MB, less if the host caps media downloads lower) and the site's own upload limit applies.
- `upload_media` sends the alt text, title, caption and description with the upload itself (alt text up to 300 characters, caption up to 500, description up to 1,000); `update_media` takes longer ones.
- A date with `Z` or an offset (`+03:00`) is a fixed moment; a date without one is in the site's own time zone.
- `set_seo_meta` writes only on sites running Rank Math with its REST API; WordPress itself cannot read those fields back.
- `api_get` and `api_request` refuse application passwords (any method); changes to plugins, themes, site settings and users, the connected user included; batch requests (`/batch/v1`); query parameters PHP reads as `_method` or `rest_route` (such as `.method` or `rest[route`), which would change a request's method or route; path segments holding an encoded slash or backslash; and bodies other than JSON.
- `api_get` and `api_request` also reach plugin routes, with the rights of the connector's user: give it an Author or Editor account, not an Administrator.
- `create_term` looks for an existing category under the parent it was to have (the top level by default), so a category of the same name elsewhere in the tree is never taken for it.
- Writes are never retried: a create or update whose outcome is unclear comes back as unknown, with the read tool to check first.

## README rows

Connectors table:

```markdown
| `wordpress` | [WordPress](https://wordpress.org) on your own site: draft, schedule and publish posts and pages with categories, tags and a featured image, upload media from a URL with alt text, create categories and tags, set Rank Math SEO fields, and call the rest of the REST API | Site URL, user name and application password | Available |
```

Quick start table:

```markdown
| `wordpress` | `WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APPPASSWORD` | The site's address (with its subdirectory, if any), the connector user's login name, and an application password from Users → Profile → Application Passwords. |
```

Tools: the table above, under `### wordpress`.
