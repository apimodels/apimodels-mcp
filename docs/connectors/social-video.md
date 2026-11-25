# apimodels Social Video Insights — connector guide

apimodels Social Video Insights is a remote MCP connector that reads public social-media posts and turns what is said in their videos into text. It is one of three single-purpose connectors run by [apimodels.app](https://apimodels.app), a multi-model AI API platform operated by Pixlume. Use it to research content: read a post's caption, author and engagement counts, list a channel's recent posts, pull a video's subtitles, or get a transcript of a short video so Claude can summarize or compare it.

It never returns media download links and does not download videos for you: the output is text and numbers only. It does not generate any media.

| | |
|---|---|
| Connector URL | `https://api.apimodels.app/mcp/social` |
| Transport | Streamable HTTP |
| Sign-in | OAuth 2.0 with your apimodels.app account (dynamic client registration supported) |
| Cost | $0.004 per post or subtitle lookup, $0.02 per page of a channel listing, $0.0025 per audio minute for transcription, from your prepaid balance |
| Support | support@apimodels.app |

## Connect it

1. In Claude, open **Settings → Connectors → Add custom connector** (or add it from the directory) and enter `https://api.apimodels.app/mcp/social`.
2. Claude opens apimodels.app. Sign in (Google or Alipay) and approve the request.
3. Approval creates an API key named `MCP · <client> · <date>` in your account. The connector uses that key and nothing else. To disconnect, delete the key at [apimodels.app/console/api-keys](https://apimodels.app/console/api-keys) or remove the connector in Claude.

Lookups are paid from the account's prepaid USD balance. Check it with `get_balance`; top up at [apimodels.app/console/credits](https://apimodels.app/console/credits).

## Supported sites

YouTube, TikTok, Instagram, X, Facebook, Xiaohongshu, Bilibili, Douyin, Weibo and more than 1,000 other sites. Short links work. Only public posts can be read; private, deleted and login-only posts return an error and are not charged.

## Tools

| Tool | What it does | Cost | Annotations |
|---|---|---|---|
| `read_post` | Reads one public post or video page: caption or title, site, post URL, author, engagement counts when the site provides them, and how many images or videos it contains. | $0.004 | not read-only, not destructive |
| `list_posts` | Lists posts from a public profile, channel, playlist or topic page, one page at a time, with a cursor for the next page. | $0.02 per page | not read-only, not destructive |
| `get_subtitles` | Returns the published subtitles of a YouTube or Bilibili video as plain text, with the list of available languages. | $0.004 | not read-only, not destructive |
| `transcribe_post` | Reads a video post and returns its caption, author and counts with the full text of what is said. YouTube and Bilibili use the video's published subtitles when it has them; other sites are transcribed (optional word timestamps with speakers, or translation). | $0.004 + $0.004 (subtitles) or $0.0025 / audio minute (transcription) | not read-only, not destructive |
| `get_transcription` | Returns the result of a transcription that was still running, by its job id. | free | read-only |
| `get_balance` | Returns the account's available balance and the amount held for running jobs. | free | read-only |

The paid tools are marked "not read-only" because each call spends balance; none of them changes anything on the social site. Failed lookups and failed transcriptions are not charged.

## Limits

- Public content only. The connector does not sign in to social sites on your behalf.
- Some sites serve video only to their own app. Those videos cannot be transcribed; the tool says so and charges nothing for the attempt.
- YouTube and Bilibili videos without published subtitles cannot be transcribed through this connector.
- Engagement counts are whatever the site shows publicly at the time of the call; some sites hide some counts. Channel listings on some sites (YouTube among them) give each post's id, title, duration and age but no counts; read a single post for its counts.
- A transcription waits up to 50 seconds; longer videos return a job id, and the result stays available for 30 days.

## Example prompts

1. "Read this TikTok and tell me what the creator says and how the post is performing: https://www.tiktok.com/@scout2015/video/6718335390845095173"
2. "Get the English subtitles of https://www.youtube.com/watch?v=jNQXAC9IVRw and summarize the video in one sentence."
3. "List the latest videos on https://www.youtube.com/@NASA and group their titles by topic."

## Data handling

- The connector reads only the public URLs you give it. It does not access your social-media accounts.
- Post data is returned to Claude and not kept by the connector. Transcripts are stored in your account's storage and deleted automatically after 30 days.
- Usage records (time, tool, cost) are kept for billing, as described in the [privacy policy](https://apimodels.app/privacy).
- Respect each site's terms and the rights of creators when you reuse what you read.

## Troubleshooting

| Message | Meaning |
|---|---|
| `NO TRANSCRIPT — … does not let this video be fetched` | The site serves the video only to its own app. Nothing was charged for the transcription. |
| `No subtitles are published for this video.` | The YouTube or Bilibili video has no subtitle track. |
| `STILL RUNNING — transcription job …` | The video is longer than the wait window; ask for the result by its job id with `get_transcription`. |
| `Insufficient balance` | Top up at apimodels.app/console/credits. |

## Links

- Privacy policy: https://apimodels.app/privacy
- Terms: https://apimodels.app/terms
- Media API reference: https://apimodels.app/docs
- Source code: https://github.com/apimodels/apimodels-mcp (`src/profiles.ts`)
- Contact: support@apimodels.app
