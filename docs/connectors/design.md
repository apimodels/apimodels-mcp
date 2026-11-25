# apimodels Design Assets — connector guide

apimodels Design Assets is a remote MCP connector that makes visual aids for design work: logos, icons, presentation slide visuals and UI mockups. It is one of three single-purpose connectors run by [apimodels.app](https://apimodels.app), a multi-model AI API platform operated by Pixlume. Use it when you are building a deck, an app or a brand and need a first logo, a matching icon, a cover visual that leaves room for slide text, or a screen mockup for a design discussion.

It makes design assets only. It is not a general image generator: it does not take free-form picture prompts, does not edit photos, and its prompts are fixed to flat or vector-style graphics with no photorealistic people and no real persons.

| | |
|---|---|
| Connector URL | `https://api.apimodels.app/mcp/design` |
| Transport | Streamable HTTP |
| Sign-in | OAuth 2.0 with your apimodels.app account (dynamic client registration supported) |
| Cost | $0.0315 per SVG logo or icon, $0.02 per 1024×1024 PNG logo or icon, $0.035 per 2K slide visual or UI mockup, from your prepaid balance |
| Support | support@apimodels.app |

## Connect it

1. In Claude, open **Settings → Connectors → Add custom connector** (or add it from the directory) and enter `https://api.apimodels.app/mcp/design`.
2. Claude opens apimodels.app. Sign in (Google or Alipay) and approve the request.
3. Approval creates an API key named `MCP · <client> · <date>` in your account. The connector uses that key and nothing else. To disconnect, delete the key at [apimodels.app/console/api-keys](https://apimodels.app/console/api-keys) or remove the connector in Claude.

Assets are paid from the account's prepaid USD balance. Check it with `get_balance`; top up at [apimodels.app/console/credits](https://apimodels.app/console/credits).

## Tools

| Tool | What it makes | Output | Cost | Annotations |
|---|---|---|---|---|
| `create_logo` | A symbol, a wordmark or both for a named brand, product or project | SVG, or 1024×1024 PNG | $0.0315 SVG / $0.02 PNG | not read-only, not destructive |
| `create_icon` | One interface icon, app icon or concept icon (outline, filled, flat color, app icon, isometric) | SVG, or 1024×1024 PNG | $0.0315 SVG / $0.02 PNG | not read-only, not destructive |
| `create_slide_visual` | A cover illustration, section divider or background for a slide, with empty space kept where the slide text goes; no text in the image | 16:9 or 4:3 PNG at 2K | $0.035 | not read-only, not destructive |
| `create_ui_mockup` | A flat, straight-on mockup of a mobile screen, web page or dashboard from a description of its content | PNG at 2K (9:16 mobile, 16:9 web) | $0.035 | not read-only, not destructive |
| `get_design` | The result of a job that was still running, by its job id | link and preview | free | read-only |
| `get_balance` | The account's available balance and the amount held for running jobs | text | free | read-only |

Each tool returns a link to the file (valid for 30 days) and, for PNG files, a small preview Claude can look at. Failed jobs are not charged.

## Limits

- Design assets only: logos, icons, slide visuals and UI mockups in a graphic style. Photographs, pictures of people and edits of existing images are out of scope.
- A UI mockup is an image for discussion, not working code.
- Generated text inside an image (wordmarks, interface labels) can contain spelling mistakes; check it before use. SVG output is the best choice when you need to edit shapes or colors afterwards.
- Check that a logo does not resemble an existing trademark before you register or publish it.
- A call waits up to 50 seconds; slower jobs return a job id, and the result stays available for 30 days.

## Example prompts

1. "Design a logo for my budgeting app called Penny Plan: friendly, rounded, green and navy, symbol next to the wordmark, as SVG."
2. "I'm building a 10-slide deck on our Q3 cloud cost review. Make a 16:9 cover visual in flat illustration style with space on the left for the title, in our colors #1F3A7A and #F2B134."
3. "Mock up the home screen of a mobile habit tracker: today's habits as cards with checkboxes, a weekly streak bar at the top, and a bottom tab bar. Light, minimal, rounded cards."

## Data handling

- The connector sends the text of your request (names, briefs, descriptions) to the image model with a fixed design-only instruction. It does not read files or other parts of your conversation.
- Result files are stored in your account's storage and deleted automatically after 30 days.
- Usage records (time, tool, cost) are kept for billing, as described in the [privacy policy](https://apimodels.app/privacy).

## Troubleshooting

| Message | Meaning |
|---|---|
| `STILL RUNNING — design job …` | The job is taking longer than the wait window; ask for it by its job id with `get_design`. |
| `FAILED — … not charged` | The request could not be completed (for example it was declined by the model's content policy). Nothing was charged. |
| `Insufficient balance` | Top up at apimodels.app/console/credits. |

## Links

- Privacy policy: https://apimodels.app/privacy
- Terms: https://apimodels.app/terms
- Image API reference: https://apimodels.app/docs
- Source code: https://github.com/apimodels/apimodels-mcp (`src/profiles.ts`)
- Contact: support@apimodels.app
