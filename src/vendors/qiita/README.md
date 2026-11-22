# Qiita connector

Technical articles on [Qiita](https://qiita.com) through [Qiita API v2](https://qiita.com/api/v2/docs) with your own personal access token: new articles saved as limited-share articles (限定共有) for review and made public only when asked, updates with 1 to 5 tags and their versions, your articles' likes, stocks, comments and page views, tag lookups and a search of Qiita before writing. Qiita Team (team sites such as `your-team.qiita.com`) is not covered.

| | |
| --- | --- |
| What it can do | Save limited-share articles and make them public, update and delete articles, rank your articles by likes and stocks, page views, tags and search |
| Auth | A Qiita personal access token (`read_qiita` and `write_qiita`) |
| Environment variable | `QIITA_TOKEN` |
| Where to get it | qiita.com → Settings → Applications → Personal access tokens → Generate new token |

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `token` | `QIITA_TOKEN` | Yes |

The token goes only to `https://qiita.com/api/v2/`, as `Authorization: Bearer <token>`.

### Where to get the token

1. Sign in at [qiita.com](https://qiita.com) with the account the articles should appear under.
2. Click your profile icon at the top right, choose **設定** (Settings), then **アプリケーション** (Applications), or open [qiita.com/settings/applications](https://qiita.com/settings/applications).
3. Under **個人用アクセストークン** (Personal access tokens), click **新しくトークンを発行する** (Generate new token). [This link](https://qiita.com/settings/tokens/new?read_qiita=1&write_qiita=1) opens the form with both scopes below ticked.
4. Enter a description you will recognize later.
5. Tick **read_qiita** and **write_qiita**. Leave **read_qiita_team** and **write_qiita_team** off.
6. Issue the token and copy it at once: Qiita shows it only this one time. It is 40 characters of digits and the letters a to f.

Qiita accounts are free and the API needs no paid plan.

### How to revoke it

Delete the token on the same **アプリケーション** page; it stops working at once. Issue a new token to reconnect.

## Tools

Articles can be named by their ID (20 hexadecimal characters) or by their qiita.com link.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_my_account` | read | The account: ID, name, article and follower counts, whether it is team-only, the image upload allowance of Qiita's editor, and the requests left this hour. |
| `list_my_articles` | read | Your articles, limited-share ones included, with likes, stocks, comments and tags, newest first, or ranked by likes, stocks, comments or last update across all of them (up to 1,000). |
| `get_article` | read | One article with its status, tags and counts, its page views when it is yours, and its Markdown on request (in windows with a cursor). |
| `search_articles` | read | Public Qiita articles by Qiita's search terms (`title:`, `tag:`, `user:`, `stocks:>50`, ...), with their authors and counts. |
| `get_tag` | read | One tag as Qiita spells it, with its article and follower counts (tags such as `C#` included). |
| `list_tags` | read | Qiita's tags, the most used first or by name. |
| `create_article` | create | Saves an article: limited share by default; `public: true` posts it publicly at once, with an Organization link or a tweet from the linked account if asked. |
| `update_article` | update | Changes an article's title, body, tags or slide mode, keeping the rest; never switches limited share or public. |
| `make_article_public` | update | Makes a limited-share article public, keeping its text and tags. Final: Qiita cannot make it limited again. |
| `delete_article` | delete | Deletes an article for good, with its likes, stocks and comments. |
| `api_get` | read | Any other GET of Qiita API v2 under `/api/v2/`, such as comments, stocks or followers, with the paging and rate headers. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to Qiita API v2 under `/api/v2/`, such as stocking an article or posting a comment. Sent once, never retried. |

## Limits

- Qiita allows 1,000 requests an hour with a token. Results say how many are left and when the hour resets (`rate_limit`); a `429` comes back as an error, and nothing is retried. Ranking your articles reads up to 10 pages of 100, one request each.
- A limited-share article is the only draft Qiita has. Going public is final, every revision saved while the article was limited becomes visible in its edit history, and `@mentions` notify people only once it is public. Organizations and tweets go with public articles only; posting campaigns are not offered.
- Lists carry no page views: Qiita gives them only to the author, one article at a time (`get_article`).
- Qiita's API cannot upload images: articles use images that already have a lasting public https URL.
- Qiita Team, its groups, co-editing and emoji reactions are not covered.
