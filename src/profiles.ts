/**
 * Single-purpose hosted connectors (2026-11-25), served next to the full server:
 *
 *   POST /mcp/transcribe   speech to text for audio and video files
 *   POST /mcp/social       read public social-media posts and turn their videos into text
 *   POST /mcp/design       logos, icons, slide visuals and UI mockups (design assets only)
 *
 * Why separate connectors: the Claude directory (Anthropic Software Directory Policy) does not list
 * software that generates images, video or audio, except design-only image software that makes visual
 * aids. The full server (/mcp) does all of that and stays as it is for every other client. Each profile
 * here exposes only what fits one purpose, so it can be reviewed and listed on its own.
 *
 * Rules every tool here follows (policy section 2 and 5):
 *   - descriptions say what the tool does, what it costs and its limits; they do not tell the model
 *     which other tool to call or how to behave;
 *   - results state facts (finished / failed / still running with a job id), not instructions;
 *   - every tool carries title, readOnlyHint and destructiveHint;
 *   - the social profile never returns media download links (captions, stats and transcripts only).
 *
 * Helpers come from index.ts through ProfileHelpers, so this module has no import cycle with it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export const PROFILES = ['transcribe', 'social', 'design'] as const
export type Profile = (typeof PROFILES)[number]
export const isProfile = (s: string): s is Profile => (PROFILES as readonly string[]).includes(s)

export const PROFILE_INFO: Record<Profile, { serverName: string; resourceName: string }> = {
  transcribe: { serverName: 'apimodels-transcribe', resourceName: 'apimodels Transcribe' },
  social: { serverName: 'apimodels-social-video', resourceName: 'apimodels Social Video Insights' },
  design: { serverName: 'apimodels-design', resourceName: 'apimodels Design Assets' },
}

type Kind = 'images' | 'video' | 'audio'
type Transcript = { task: 'transcribe' | 'translate'; text: string; duration?: number; transcriptUrl?: string; silent?: boolean; truncated?: boolean }
type TaskState =
  | { state: 'completed'; urls: string[]; kind: Kind; transcript?: Transcript }
  | { state: 'failed'; message: string; retryable: boolean; kind: Kind }
  | { state: 'running'; elapsedS: number; kind: Kind }

export interface ProfileHelpers {
  version: string
  waitCap: () => number
  apiFetch: (path: string, init?: RequestInit) => Promise<any>
  submitAndWait: (kind: Kind, body: Record<string, unknown>, waitS: number) => Promise<{ taskId: string; state: TaskState }>
  pollTask: (kind: Kind, taskId: string, waitS: number) => Promise<TaskState>
  transcriptText: (t: Transcript) => string
  imagePreview: (url: string) => Promise<{ data: string; mimeType: string } | null>
  uploadLink: (filename: string) => { url: string; ttlMinutes: number }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const BILLABLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const

const LANGS = [
  'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'nl', 'pl', 'cs', 'sk', 'hi', 'bg',
  'hr', 'da', 'et', 'fi', 'hu', 'lv', 'lt', 'ro', 'sl', 'sv', 'th', 'uk', 'ar', 'el', 'he', 'mt',
] as const

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true })

/** Neutral status lines: what happened, never what to call next. */
function statusText(jobId: string, s: TaskState, what: string): string {
  if (s.state === 'running') return `STILL RUNNING — ${what} job ${jobId}, ${s.elapsedS} s elapsed. The job keeps running and is charged once, when it finishes. Its result stays available for 30 days under this job id.`
  if (s.state === 'failed') return `FAILED — ${what} job ${jobId}: ${s.message}. Failed jobs are not charged.${s.retryable ? ' The failure looks temporary.' : ''}`
  return ''
}

function balanceTool(server: McpServer, h: ProfileHelpers) {
  server.tool(
    'get_balance',
    'Returns the prepaid USD balance of the signed-in apimodels.app account: the amount available now, and the amount held for jobs that are still running. Free.',
    {},
    { title: 'Get balance', ...READ_ONLY },
    async () => {
      try {
        const j = await h.apiFetch('/balance')
        const d = j?.data ?? j
        const n = (v: unknown) => Number(v ?? 0).toFixed(4)
        return text(`Balance: ${n(d?.balance)} ${d?.currency ?? 'USD'} available, ${n(d?.frozen)} held for running jobs. Top up at https://apimodels.app/console/credits`)
      } catch (e) { return fail(e) }
    },
  )
}

const waitParam = (h: ProfileHelpers, what: string) =>
  z.number().int().min(0).max(h.waitCap()).default(h.waitCap())
    .describe(`How long to wait for the ${what} before returning a job id instead, in seconds (0–${h.waitCap()}).`)

// ── Speech to text (shared by transcribe and social) ────────────────────────────────────────────

const TRANSCRIBE_PRICE = '$0.0025 per audio minute ($0.15 per hour), billed by the second'

async function transcribeUrl(h: ProfileHelpers, url: string, opts: { timestamps?: boolean; translate_to?: string }, waitS: number) {
  if (opts.timestamps && opts.translate_to) throw new Error('timestamps and translate_to cannot be combined in one job: run one job for each.')
  const body: Record<string, unknown> = {
    model: 'nemotron-3.5-transcribe',
    audio_url: url,
    ...(opts.timestamps != null ? { timestamps: opts.timestamps } : {}),
    ...(opts.translate_to ? { target_language: opts.translate_to } : {}),
  }
  return h.submitAndWait('audio', body, waitS)
}

function transcriptResult(h: ProfileHelpers, jobId: string, s: TaskState) {
  if (s.state !== 'completed') return { ...text(statusText(jobId, s, 'transcription')), ...(s.state === 'failed' ? { isError: true } : {}) }
  if (!s.transcript) return text(`Job ${jobId} finished. Result: ${s.urls.join('\n')}`)
  return text(h.transcriptText(s.transcript))
}

function getTranscriptionTool(server: McpServer, h: ProfileHelpers) {
  server.tool(
    'get_transcription',
    'Returns the result of a transcription job by its job id: the transcript text, audio duration and a link to the full JSON result when the job has finished; the failure reason if it failed; or its status if it is still running. Waits up to wait_seconds for a running job. Free.',
    {
      job_id: z.string().describe('The job id returned for a transcription that was still running.'),
      wait_seconds: waitParam(h, 'transcript'),
    },
    { title: 'Get transcription', ...READ_ONLY },
    async ({ job_id, wait_seconds }) => {
      try {
        const id = job_id.trim()
        return transcriptResult(h, id, await h.pollTask('audio', id, wait_seconds))
      } catch (e) { return fail(e) }
    },
  )
}

// ── Profile: transcribe ─────────────────────────────────────────────────────────────────────────

function buildTranscribe(server: McpServer, h: ProfileHelpers) {
  server.tool(
    'transcribe',
    `Transcribes the speech in an audio file, or in the audio track of a video file, into text (model: nemotron-3.5-transcribe). Input: a public HTTPS URL that downloads the file directly; mp3, wav, m4a, aac, flac, ogg, opus, webm, mp4 or mov, up to 60 minutes and 200 MB. Options: word-level timestamps with speaker labels (up to 8 speakers), or translation of the speech into another language instead of a transcript. Output: the transcript text, the audio duration and a link to the full result as JSON, kept for 30 days. Long recordings that are not finished within wait_seconds return a job id. Cost: ${TRANSCRIBE_PRICE}, charged to the signed-in apimodels.app balance; failed jobs and files whose length cannot be read are not charged. Whole-file transcription only, not live audio.`,
    {
      url: z.string().url().describe('Public HTTPS URL of the audio or video file.'),
      timestamps: z.boolean().optional().describe('Include word-level start and end times and speaker labels in the JSON result. Cannot be combined with translate_to.'),
      translate_to: z.enum(LANGS).optional().describe('Translate the speech into this language (ISO 639-1 code) instead of transcribing it. Translation to or from English is the supported case.'),
      wait_seconds: waitParam(h, 'transcript'),
    },
    { title: 'Transcribe audio or video', ...BILLABLE },
    async ({ url, timestamps, translate_to, wait_seconds }) => {
      try {
        const { taskId, state } = await transcribeUrl(h, url, { timestamps, translate_to }, wait_seconds)
        return transcriptResult(h, taskId, state)
      } catch (e) { return fail(e) }
    },
  )

  getTranscriptionTool(server, h)

  server.tool(
    'get_upload_link',
    'Creates a one-time HTTPS upload link for an audio or video file that is on the user\'s computer rather than at a public URL. The link is valid for 15 minutes and accepts one file sent with HTTP PUT (for example curl -T); the response to the upload contains a public URL for the file. Audio files up to 10 MB and video files up to 50 MB. The link can only receive a file; it cannot spend credits. Free.',
    {
      filename: z.string().describe('File name with extension, for example interview.m4a or meeting.mp4; used to set the file type.'),
    },
    { title: 'Get upload link', ...READ_ONLY },
    async ({ filename }) => {
      try {
        const { url, ttlMinutes } = h.uploadLink(filename)
        return text(`Upload link (valid ${ttlMinutes} minutes, one file):\n${url}\n\nExample: curl -sS -T "<path to the file>" "${url}"\nThe upload responds with {"url": "https://…"}: the public URL of the file.`)
      } catch (e) { return fail(e) }
    },
  )

  balanceTool(server, h)
}

// ── Profile: social ─────────────────────────────────────────────────────────────────────────────

/** Keys that carry media files or the request headers needed to fetch them: never shown by this profile. */
const MEDIA_KEYS = new Set(['resource_url', 'video_url', 'audio_url', 'download_url', 'variants', 'headers', 'preview_url', 'url_list', 'play_url', 'stream_url'])

/** Drop media links recursively; keep captions, authors, post URLs and counts. */
function withoutMedia(v: unknown, depth = 0): unknown {
  if (depth > 8 || v == null) return v
  if (Array.isArray(v)) return v.map((x) => withoutMedia(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (MEDIA_KEYS.has(k)) continue
      out[k] = withoutMedia(x, depth + 1)
    }
    return out
  }
  return v
}

function postSummary(d: any): string {
  const medias: any[] = Array.isArray(d?.medias) ? d.medias : []
  const types = medias.map((m) => String(m?.media_type ?? 'media'))
  const counts = types.reduce<Record<string, number>>((a, t) => ((a[t] = (a[t] ?? 0) + 1), a), {})
  const lines = [
    `Site: ${d?.site ?? 'unknown'}`,
    ...(d?.post_url ? [`Post: ${d.post_url}`] : []),
    ...(d?.author ? [`Author: ${typeof d.author === 'string' ? d.author : JSON.stringify(withoutMedia(d.author))}`] : []),
    ...(d?.stats ? [`Stats: ${JSON.stringify(d.stats)}`] : []),
    `Media in the post: ${medias.length ? Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') : 'none'}`,
    '',
    `Caption / title:\n${String(d?.text ?? d?.title ?? '(none)').trim() || '(none)'}`,
  ]
  return lines.join('\n')
}

/** The best audio-bearing URL of the first video / audio item, for transcription. Never returned to the caller. */
function speechSource(d: any): string | null {
  const medias: any[] = Array.isArray(d?.medias) ? d.medias : []
  for (const m of medias) {
    const t = String(m?.media_type ?? '').toLowerCase()
    if (t && !/video|audio/.test(t)) continue
    const variants: any[] = Array.isArray(m?.variants) ? m.variants : []
    const audio = variants.find((v) => typeof v?.audio_url === 'string')?.audio_url
    if (audio) return audio
    const video = [...variants].reverse().find((v) => typeof v?.video_url === 'string')?.video_url
    if (typeof m?.resource_url === 'string') return m.resource_url
    if (video) return video
  }
  return null
}

/** Subtitle file → plain text (SRT / VTT / json3 / json). */
function subtitleToText(body: string, hint: string): string {
  const trimmed = body.trim()
  if (hint.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(trimmed)
      const events: any[] = Array.isArray(j?.events) ? j.events : Array.isArray(j?.body) ? j.body : Array.isArray(j) ? j : []
      const parts = events.map((e) => (Array.isArray(e?.segs) ? e.segs.map((s: any) => s?.utf8 ?? '').join('') : e?.content ?? e?.text ?? '')).map((s: string) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
      if (parts.length) return parts.join('\n')
    } catch { /* fall through to line parsing */ }
  }
  return trimmed
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT/.test(l) && !/^(NOTE|STYLE|Kind:|Language:)/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l, i, a) => l && l !== a[i - 1])
    .join('\n')
}

function buildSocial(server: McpServer, h: ProfileHelpers) {
  const sites = 'YouTube, TikTok, Instagram, X, Facebook, Xiaohongshu, Bilibili, Douyin, Weibo and 1000+ other sites; short links work'

  server.tool(
    'read_post',
    `Reads one public social-media post or video page (${sites}) and returns its caption or title, the site, the post URL, the author and engagement counts when the site provides them, and how many images or videos the post contains. Media files are not downloaded and no media links are returned. Cost: $0.004 per post, charged to the signed-in apimodels.app balance; failed lookups are not charged.`,
    { url: z.string().url().describe('URL of the public post or video page.') },
    { title: 'Read social post', ...BILLABLE },
    async ({ url }) => {
      try {
        const res = await h.apiFetch('/media/extract', { method: 'POST', body: JSON.stringify({ url }) })
        return text(postSummary(res?.data ?? res))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'list_posts',
    `Lists posts from a public profile, channel, playlist or topic page (${sites}), one page at a time: each post's URL, title or caption and engagement counts when available, plus a cursor for the next page. No media links are returned. Cost: $0.02 per page, charged to the signed-in apimodels.app balance; failed lookups are not charged.`,
    {
      url: z.string().url().describe('URL of the public profile, channel, playlist or topic page.'),
      cursor: z.string().optional().describe('The next_cursor value from the previous page, to get the page after it.'),
    },
    { title: 'List social posts', ...BILLABLE },
    async ({ url, cursor }) => {
      try {
        const res = await h.apiFetch('/media/playlist', { method: 'POST', body: JSON.stringify({ url, ...(cursor ? { cursor } : {}) }) })
        return text(JSON.stringify(withoutMedia(res?.data ?? res), null, 2))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'get_subtitles',
    'Returns the published subtitles of a YouTube or Bilibili video as plain text, with the list of subtitle languages available. Uses the subtitles the video already has; videos without subtitles return none. Cost: $0.004 per video, charged to the signed-in apimodels.app balance; failed lookups are not charged.',
    {
      url: z.string().url().describe('URL of the YouTube or Bilibili video.'),
      language: z.string().optional().describe('Preferred subtitle language code, for example en or zh. Defaults to the first track.'),
    },
    { title: 'Get video subtitles', ...BILLABLE },
    async ({ url, language }) => {
      try {
        const res = await h.apiFetch('/media/subtitles', { method: 'POST', body: JSON.stringify({ url }) })
        const d = res?.data ?? res
        const tracks: any[] = Array.isArray(d?.subtitles) ? d.subtitles : []
        if (!tracks.length) return text(`${d?.title ? `Video: ${d.title}\n` : ''}No subtitles are published for this video.`)
        const langOf = (t: any) => String(t?.language_code ?? t?.lang ?? t?.language ?? '')
        const pick = (language && tracks.find((t) => langOf(t).toLowerCase().startsWith(language.toLowerCase()))) || tracks[0]
        const files: any[] = Array.isArray(pick?.urls) ? pick.urls : Array.isArray(pick?.formats) ? pick.formats : [pick]
        const order = ['json3', 'vtt', 'srt', 'json']
        const file = [...files].sort((a, b) => order.indexOf(String(a?.format ?? a?.ext ?? '')) - order.indexOf(String(b?.format ?? b?.ext ?? ''))).find((f) => typeof (f?.url ?? f?.download_url) === 'string')
        const fileUrl: string | undefined = file?.url ?? file?.download_url
        let body = ''
        if (fileUrl) {
          const r = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) })
          if (r.ok) body = subtitleToText(await r.text(), String(file?.format ?? file?.ext ?? fileUrl))
        }
        const langs = tracks.map(langOf).filter(Boolean)
        return text([
          ...(d?.title ? [`Video: ${d.title}`] : []),
          `Subtitle languages: ${langs.join(', ') || 'unknown'}; shown: ${langOf(pick) || 'first track'}`,
          '',
          body || '(The subtitle file could not be read.)',
        ].join('\n'))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'transcribe_post',
    `Reads one public social-media video post (${sites}) and transcribes the speech in its video into text. Returns the caption, author and engagement counts with the full transcript; options as for a transcription (word timestamps with speakers, or translation). No media links are returned. Videos that are not finished within wait_seconds return a job id. Cost: $0.004 to read the post plus ${TRANSCRIBE_PRICE}, charged to the signed-in apimodels.app balance; failed steps are not charged. Some sites serve media only to their own app, in which case the transcription fails and is not charged.`,
    {
      url: z.string().url().describe('URL of the public video post.'),
      timestamps: z.boolean().optional().describe('Include word-level start and end times and speaker labels in the JSON result. Cannot be combined with translate_to.'),
      translate_to: z.enum(LANGS).optional().describe('Translate the speech into this language (ISO 639-1 code) instead of transcribing it.'),
      wait_seconds: waitParam(h, 'transcript'),
    },
    { title: 'Transcribe social video', ...BILLABLE },
    async ({ url, timestamps, translate_to, wait_seconds }) => {
      try {
        if (timestamps && translate_to) throw new Error('timestamps and translate_to cannot be combined in one job: run one job for each.')
        const res = await h.apiFetch('/media/extract', { method: 'POST', body: JSON.stringify({ url }) })
        const d = res?.data ?? res
        const head = postSummary(d)
        const src = speechSource(d)
        if (!src) return text(`${head}\n\nThis post has no video or audio to transcribe.`)
        const { taskId, state } = await transcribeUrl(h, src, { timestamps, translate_to }, wait_seconds)
        const body = transcriptResult(h, taskId, state)
        return { ...body, content: [{ type: 'text' as const, text: `${head}\n\n${body.content[0].text}` }] }
      } catch (e) { return fail(e) }
    },
  )

  getTranscriptionTool(server, h)
  balanceTool(server, h)
}

// ── Profile: design ─────────────────────────────────────────────────────────────────────────────

const DESIGN_MODEL = 'gpt-image-2.6-flare'
const DESIGN_GUARD = 'This is a design asset, not a photograph: clean flat or vector-style graphic design, no photorealistic people, no real persons, no brand marks other than the one named.'

async function designResult(h: ProfileHelpers, jobId: string, s: TaskState, preview: boolean) {
  if (s.state !== 'completed') return { ...text(statusText(jobId, s, 'design')), ...(s.state === 'failed' ? { isError: true } : {}) }
  const previews = preview ? await Promise.all(s.urls.slice(0, 2).map((u) => (/\.svg(\?|$)/i.test(u) ? Promise.resolve(null) : h.imagePreview(u)))) : []
  return {
    content: [
      { type: 'text' as const, text: `Design asset ready (link valid 30 days):\n${s.urls.join('\n')}` },
      ...previews.flatMap((p) => (p ? [{ type: 'image' as const, data: p.data, mimeType: p.mimeType }] : [])),
    ],
  }
}

function buildDesign(server: McpServer, h: ProfileHelpers) {
  const run = async (body: Record<string, unknown>, waitS: number, preview: boolean) => {
    const { taskId, state } = await h.submitAndWait('images', { model: DESIGN_MODEL, ...body }, waitS)
    return designResult(h, taskId, state, preview)
  }
  const preview = z.boolean().default(true).describe('Attach a downscaled preview of PNG results.')

  server.tool(
    'create_logo',
    'Creates a logo for a brand, product or project: a symbol, a wordmark or both, in a clean graphic style. Output: an SVG vector file ($0.0315) or a 1024×1024 PNG on a plain background ($0.02). Returns a link to the file, valid for 30 days. Charged to the signed-in apimodels.app balance; failed jobs are not charged. Makes design assets only, not photographs or pictures of people.',
    {
      name: z.string().max(60).describe('The brand or product name to show in the logo, exactly as it should be spelled.'),
      brief: z.string().max(1500).describe('What the brand does and how the logo should feel: style, shapes, colors, what to avoid.'),
      layout: z.enum(['symbol_and_wordmark', 'wordmark', 'symbol']).default('symbol_and_wordmark').describe('Symbol with the name, the name alone, or a symbol alone.'),
      format: z.enum(['svg', 'png']).default('svg').describe('svg: scalable vector file. png: 1024×1024 image on a plain background.'),
      return_preview: preview,
      wait_seconds: waitParam(h, 'logo'),
    },
    { title: 'Create logo', ...BILLABLE },
    async ({ name, brief, layout, format, return_preview, wait_seconds }) => {
      try {
        const what = { symbol_and_wordmark: `a symbol next to the wordmark "${name}"`, wordmark: `a wordmark that spells "${name}"`, symbol: `a symbol for "${name}" with no text` }[layout]
        const prompt = `Logo design: ${what}. ${brief} Centered, generous margins, plain background, crisp edges, suitable for small sizes. ${DESIGN_GUARD}`
        return await run(format === 'svg' ? { prompt, output_format: 'svg' } : { prompt, size: '1024x1024', quality: 'medium', output_format: 'png' }, wait_seconds, return_preview)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'create_icon',
    'Creates one icon: an interface icon, an app icon or an illustration-style icon for a concept. Output: an SVG vector file ($0.0315) or a 1024×1024 PNG on a plain background ($0.02). Returns a link to the file, valid for 30 days. Charged to the signed-in apimodels.app balance; failed jobs are not charged. Makes design assets only, not photographs or pictures of people.',
    {
      subject: z.string().max(300).describe('What the icon represents, for example "cloud upload" or "budget planner app".'),
      style: z.enum(['outline', 'filled', 'flat_color', 'app_icon', 'isometric']).default('flat_color').describe('Icon style.'),
      colors: z.string().max(200).optional().describe('Colors to use, for example "navy and coral" or "#1F3A7A on white".'),
      format: z.enum(['svg', 'png']).default('svg').describe('svg: scalable vector file. png: 1024×1024 image on a plain background.'),
      return_preview: preview,
      wait_seconds: waitParam(h, 'icon'),
    },
    { title: 'Create icon', ...BILLABLE },
    async ({ subject, style, colors, format, return_preview, wait_seconds }) => {
      try {
        const look = { outline: 'thin consistent outline strokes, no fill', filled: 'solid filled shapes, single color', flat_color: 'flat colored shapes, no gradients', app_icon: 'rounded-square app icon with a simple central symbol', isometric: 'simple isometric illustration icon' }[style]
        const prompt = `Icon design for "${subject}": ${look}${colors ? `, colors ${colors}` : ''}. One icon, centered, plain background, readable at 24 px. ${DESIGN_GUARD}`
        return await run(format === 'svg' ? { prompt, output_format: 'svg' } : { prompt, size: '1024x1024', quality: 'medium', output_format: 'png' }, wait_seconds, return_preview)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'create_slide_visual',
    'Creates a visual for a presentation slide: a cover illustration, a section divider or a background graphic that leaves room for text, in a graphic (non-photographic) style. Output: a 16:9 or 4:3 PNG at 2K ($0.035). Returns a link to the file, valid for 30 days. Charged to the signed-in apimodels.app balance; failed jobs are not charged. Makes design assets only, not photographs or pictures of people.',
    {
      topic: z.string().max(500).describe('What the slide is about.'),
      style: z.enum(['flat_illustration', 'isometric', 'abstract_shapes', 'line_art', 'gradient_background']).default('flat_illustration').describe('Visual style.'),
      text_space: z.enum(['left', 'right', 'top', 'bottom', 'none']).default('left').describe('Where to keep empty space for the slide text.'),
      colors: z.string().max(200).optional().describe('Colors to use, for example brand colors.'),
      aspect_ratio: z.enum(['16:9', '4:3']).default('16:9'),
      return_preview: preview,
      wait_seconds: waitParam(h, 'slide visual'),
    },
    { title: 'Create slide visual', ...BILLABLE },
    async ({ topic, style, text_space, colors, aspect_ratio, return_preview, wait_seconds }) => {
      try {
        const look = { flat_illustration: 'flat vector illustration', isometric: 'isometric vector illustration', abstract_shapes: 'abstract geometric shapes', line_art: 'minimal line art', gradient_background: 'soft gradient background with subtle shapes' }[style]
        const space = text_space === 'none' ? '' : ` Keep the ${text_space} third empty and calm for slide text.`
        const prompt = `Presentation slide visual about ${topic}: ${look}${colors ? `, colors ${colors}` : ''}. No text in the image.${space} ${DESIGN_GUARD}`
        return await run({ prompt, aspect_ratio, resolution: '2K', quality: 'medium', output_format: 'png' }, wait_seconds, return_preview)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'create_ui_mockup',
    'Creates a mockup image of a user interface screen: a mobile app screen, a web page or a dashboard, from a description of its purpose and content, for early design discussion. Output: a PNG at 2K ($0.035); mobile screens are 9:16, web pages and dashboards 16:9. The result is an image, not code. Returns a link to the file, valid for 30 days. Charged to the signed-in apimodels.app balance; failed jobs are not charged.',
    {
      screen: z.enum(['mobile_app', 'web_page', 'dashboard']).describe('Kind of screen.'),
      description: z.string().max(2000).describe('What the screen is for and what it shows: sections, components, sample labels and data.'),
      style: z.string().max(300).optional().describe('Visual style, for example "light, minimal, rounded cards, blue accent".'),
      return_preview: preview,
      wait_seconds: waitParam(h, 'mockup'),
    },
    { title: 'Create UI mockup', ...BILLABLE },
    async ({ screen, description, style, return_preview, wait_seconds }) => {
      try {
        const label = { mobile_app: 'mobile app screen', web_page: 'web page', dashboard: 'web dashboard' }[screen]
        const prompt = `High-fidelity UI mockup of a ${label}, shown flat and straight-on (no device frame, no hands): ${description}${style ? ` Style: ${style}.` : ''} Legible interface labels, consistent spacing and alignment. ${DESIGN_GUARD}`
        return await run({ prompt, aspect_ratio: screen === 'mobile_app' ? '9:16' : '16:9', resolution: '2K', quality: 'medium', output_format: 'png' }, wait_seconds, return_preview)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'get_design',
    'Returns the result of a design job by its job id: the file link (and a preview for PNG files) when it has finished, the failure reason if it failed, or its status if it is still running. Waits up to wait_seconds for a running job. Free.',
    {
      job_id: z.string().describe('The job id returned for a design job that was still running.'),
      return_preview: preview,
      wait_seconds: waitParam(h, 'design'),
    },
    { title: 'Get design', ...READ_ONLY },
    async ({ job_id, return_preview, wait_seconds }) => {
      try {
        const id = job_id.trim()
        return await designResult(h, id, await h.pollTask('images', id, wait_seconds), return_preview)
      } catch (e) { return fail(e) }
    },
  )

  balanceTool(server, h)
}

export function buildProfileServer(profile: Profile, h: ProfileHelpers): McpServer {
  const server = new McpServer({ name: PROFILE_INFO[profile].serverName, version: h.version })
  if (profile === 'transcribe') buildTranscribe(server, h)
  else if (profile === 'social') buildSocial(server, h)
  else buildDesign(server, h)
  return server
}
