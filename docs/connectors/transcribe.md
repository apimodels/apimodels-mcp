# apimodels Transcribe — connector guide

apimodels Transcribe is a remote MCP connector that turns speech in audio and video files into text. It is one of three single-purpose connectors run by [apimodels.app](https://apimodels.app), a multi-model AI API platform operated by Pixlume. Use it when you have a recording (an interview, a meeting, a podcast episode, a lecture, a voice memo) and want the words as text, with optional timestamps and speaker labels.

It does not generate audio, images or video, and it does not transcribe live audio: it works on whole files.

| | |
|---|---|
| Connector URL | `https://api.apimodels.app/mcp/transcribe` |
| Transport | Streamable HTTP |
| Sign-in | OAuth 2.0 with your apimodels.app account (dynamic client registration supported) |
| Cost | $0.0025 per audio minute ($0.15 per hour), billed by the second, from your prepaid balance |
| Support | support@apimodels.app |

## Connect it

1. In Claude, open **Settings → Connectors → Add custom connector** (or add it from the directory) and enter `https://api.apimodels.app/mcp/transcribe`.
2. Claude opens apimodels.app. Sign in (Google or Alipay) and approve the request.
3. Approval creates an API key named `MCP · <client> · <date>` in your account. The connector uses that key and nothing else. To disconnect, delete the key at [apimodels.app/console/api-keys](https://apimodels.app/console/api-keys) or remove the connector in Claude.

Transcription is paid from the account's prepaid USD balance. Check it with the `get_balance` tool, and top up at [apimodels.app/console/credits](https://apimodels.app/console/credits).

## Tools

| Tool | What it does | Cost | Annotations |
|---|---|---|---|
| `transcribe` | Transcribes an audio or video file at a public HTTPS URL. Options: `timestamps` (the transcript comes back as time-coded lines labelled by speaker, up to 8 speakers; the JSON result adds word-level times) or `translate_to` (translate the speech into another language instead of transcribing it). Returns the transcript, the audio duration and a link to the full JSON result. | $0.0025 / audio minute | not read-only, not destructive |
| `get_transcription` | Returns the result of a job that was still running when `transcribe` returned, by its job id. | free | read-only |
| `get_upload_link` | Creates a one-time HTTPS upload link (valid 15 minutes, one file) for a file on your computer. The upload returns a public URL that `transcribe` can read. The link can only receive a file. | free | read-only |
| `get_balance` | Returns the account's available balance and the amount held for running jobs. | free | read-only |

Every billable call is charged once, when the job finishes. Failed jobs, and files whose length cannot be read, are not charged.

## Limits

- Formats: mp3, wav, m4a, aac, flac, ogg, opus, webm, mp4, mov.
- Up to 60 minutes and 200 MB per file at a URL. Files sent through an upload link: audio up to 10 MB, video up to 50 MB.
- The URL must download the file directly. Pages that only play the file in a browser player (for example a YouTube watch page) are not files.
- `timestamps` and `translate_to` cannot be combined in one job; run one job for each.
- Translation to or from English is the supported case.
- A call waits up to 50 seconds. Longer recordings return a job id; the job keeps running and its result stays available for 30 days.

## Example prompts

1. "Transcribe this interview and give me the transcript with speaker labels: https://example.com/interview.m4a"
2. "Here is our Monday stand-up recording: https://example.com/standup.mp4. Transcribe it, then list the decisions and action items with owners."
3. "Translate the speech in this Spanish podcast episode into English: https://example.com/episode-12.mp3"

## Data handling

- The connector fetches the file you point it to, sends it to the speech-to-text model, and returns the text. It does not read other files and has no access to your Claude conversation beyond the tool arguments.
- Transcripts, JSON results and uploaded files are stored in your account's storage and deleted automatically after 30 days.
- Usage records (time, tool, duration, cost) are kept for billing, as described in the [privacy policy](https://apimodels.app/privacy).
- Only transcribe recordings you have the right to process, and the consent of the people speaking where the law requires it.

## Troubleshooting

| Message | Meaning |
|---|---|
| `STILL RUNNING — transcription job …` | The file is longer than the wait window. The job continues; ask for the result by its job id with `get_transcription`. |
| `FAILED — … not charged` | The file could not be processed (unreachable URL, unsupported format, no audio track). Nothing was charged. |
| `Insufficient balance` | Top up at apimodels.app/console/credits. |
| HTTP 401 when connecting | The approval was not completed or the key was deleted. Reconnect the connector. |

## Links

- Privacy policy: https://apimodels.app/privacy
- Terms: https://apimodels.app/terms
- Speech-to-text API reference: https://apimodels.app/docs
- Source code: https://github.com/apimodels/apimodels-mcp (`src/profiles.ts`)
- Contact: support@apimodels.app
