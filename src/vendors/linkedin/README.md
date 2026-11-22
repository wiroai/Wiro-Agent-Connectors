# LinkedIn connector (`linkedin`)

Publishes and manages posts on [LinkedIn](https://www.linkedin.com) through the LinkedIn REST API (Posts and Images APIs, `LinkedIn-Version: 202611`): as a company Page (organization) or as the member who signed in. Text posts with hashtags and mentions, posts with one image or 2 to 20 images (alt text included), and article link cards with their own title, description and thumbnail. It also lists, reads and deletes posts, and reaches the rest of the API with `api_get` and `api_request`.

Post text is sent in LinkedIn's "little" format: characters LinkedIn reserves, such as `( ) * _ < >`, are escaped, so a post reads exactly as written and is never cut at a parenthesis. `#hashtags` stay hashtags and `@[Name](urn:li:organization:123)` stays a mention.

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `access_token` | `LINKEDIN_ACCESS_TOKEN` | yes |
| `organizationid` | `LINKEDIN_ORGANIZATIONID` | to post as a Page |
| `linkedinname` | `LINKEDIN_LINKEDINNAME` | no |

**`access_token`**: an OAuth 2.0 access token of the member, from your own LinkedIn app. A host that connects LinkedIn for you runs this sign-in and refreshes the token; the connector never refreshes or stores it. To get one yourself:

1. Open [LinkedIn Developers → My apps](https://www.linkedin.com/developers/apps) and create an app linked to your LinkedIn Page.
2. Under **Products**, add **Sign In with LinkedIn using OpenID Connect** (`openid`, `profile`), **Share on LinkedIn** (`w_member_social`, to post as the member) and, to post as the Page, the **Community Management API** (`w_organization_social`, `r_organization_social`; LinkedIn reviews this product).
3. On the **Auth** tab, add your redirect URL and copy the client ID and secret.
4. Send the member to `https://www.linkedin.com/oauth/v2/authorization` with those scopes, and exchange the returned code at `https://www.linkedin.com/oauth/v2/accessToken`. Access tokens last 60 days.

To revoke it, the member removes the app at LinkedIn → **Settings & Privacy** → **Data privacy** → **Permitted services**. The app owner can also reset the client secret on the app's **Auth** tab, which ends every token of the app.

**`organizationid`**: the numeric id of the Page to post for. Open the Page in admin view; the id is the number after `/company/` in the address, such as `linkedin.com/company/12345678/admin/` → `12345678` (a pasted admin URL or `urn:li:organization:12345678` works too). The member must be an administrator or content admin of that Page. Without it, posts go out as the member. To stop posting for the Page, clear the value or remove the member's Page role.

**`linkedinname`**: the connected member's name, which a host writes after the sign-in. It is only shown back.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The member who signed in: id, person URN, name, photo, locale, and the Page the connection posts for. |
| `list_posts` | read | The Page's posts, newest first, with URN, link, text, content type, visibility and times; the member's own posts with `author: "member"` (LinkedIn allows that only to apps approved for `r_member_social`). Paged with a cursor. |
| `get_post` | read | One post by its URN, as its author sees it. |
| `create_post` | create | Publishes right away, as the Page or the member: text up to 3,000 characters, optionally up to 20 images (JPEG, PNG or GIF from public https URLs, with alt text) or an article card. Every image is uploaded before the post is made. Returns the post URN and link. |
| `delete_post` | delete | Deletes one post by its URN, for good. |
| `api_get` | read | Any other GET under `/rest/` or `/v2/`, with the version headers, such as `/rest/organizationAcls?q=roleAssignee`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/rest/` or `/v2/`; PATCH is sent as a Rest.li partial update. Sent once, never retried. |

## Limits

- Images: JPEG, PNG or GIF (no WebP), under 36,152,320 pixels, up to 20 MB each as downloaded here, and within the host's own download limit (25 MiB in the CLI). Video and document posts are not covered.
- A post goes live at once; LinkedIn's API has no drafts. `CONNECTIONS` visibility is for member posts only.
- LinkedIn retires each API version about a year after its release; `202611` is supported until late 2027.
- LinkedIn's daily rate limits apply per member and per app; a 429 comes back with `retryAfter` when LinkedIn sends one.
- Writes are never retried: an unclear outcome comes back as unknown, with `list_posts` (or `get_post`) to check.

## README rows

For the repository README: the Tools table above goes under `### linkedin` in its Tools section, and these rows go in the Connectors and Quick start tables.

```markdown
| `linkedin` | [LinkedIn](https://www.linkedin.com): publish text, image, multi-image and article posts as a company Page or as the member, list, read and delete posts, and call the rest of the REST API | OAuth access token | Available |
```

```markdown
| `linkedin` | `LINKEDIN_ACCESS_TOKEN`, optional `LINKEDIN_ORGANIZATIONID` (to post as a Page) and `LINKEDIN_LINKEDINNAME` | An OAuth access token from your own LinkedIn app (see `src/vendors/linkedin/README.md`), and the number in your Page's admin URL. |
```
