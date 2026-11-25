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
  transcribe: { serverName: 'apimodels-transcribe', resourceName: 'Audio & Video Transcription (apimodels)' },
  social: { serverName: 'apimodels-social-video', resourceName: 'Transcripts for YouTube, TikTok & Instagram (apimodels)' },
  design: { serverName: 'apimodels-design', resourceName: 'Design Assets (apimodels)' },
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
  /** Set by buildProfileServer: which connector is answering (for the top-up link's campaign tag). */
  profile?: Profile
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const BILLABLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const

const LANGS = [
  'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'nl', 'pl', 'cs', 'sk', 'hi', 'bg',
  'hr', 'da', 'et', 'fi', 'hu', 'lv', 'lt', 'ro', 'sl', 'sv', 'th', 'uk', 'ar', 'el', 'he', 'mt',
] as const

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

/** Credits page, tagged with the connector so top-ups that start here can be told apart in analytics. */
const topUpUrl = (profile?: Profile) =>
  `https://apimodels.app/console/credits?utm_source=mcp_connector&utm_medium=mcp&utm_campaign=${profile ?? 'mcp'}`

/** The API answers HTTP 402 (msg "Insufficient credits") when the balance cannot cover a request. */
const isInsufficient = (msg: string) => /HTTP 402|insufficient (credits|balance)/i.test(msg)

const fail = (e: unknown, profile?: Profile) => {
  const msg = e instanceof Error ? e.message : String(e)
  const out = isInsufficient(msg)
    ? `INSUFFICIENT BALANCE — the signed-in apimodels.app account does not have enough prepaid balance for this request. Nothing was run and nothing was charged. Top up at ${topUpUrl(profile)}; the balance can be used as soon as the payment goes through.`
    : `Error: ${msg}`
  return { content: [{ type: 'text' as const, text: out }], isError: true }
}

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
        return text(`Balance: ${n(d?.balance)} ${d?.currency ?? 'USD'} available, ${n(d?.frozen)} held for running jobs. Top up at ${topUpUrl(h.profile)}`)
      } catch (e) { return fail(e, h.profile) }
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

/** 83.4 → "01:23"; 3725 → "1:02:05". */
function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/
/** Words → text: spaces between words, none between two CJK characters. */
function joinWords(words: string[]): string {
  return words.reduce((out, w) => (!out ? w : CJK.test(out.slice(-1)) && CJK.test(w[0]) ? out + w : `${out} ${w}`), '')
}

const TIMED_MAX_CHARS = 60_000

/**
 * A timestamped job's JSON → time-coded lines, one per speaker turn (split at sentence ends after ~8 s and
 * at the latest every 30 s): "[00:00–00:07] Speaker 1: …". Null when the result has no word timings.
 */
export function timedLines(result: any): string | null {
  const words: any[] = Array.isArray(result?.words) ? result.words : []
  if (!words.length) return null
  const hasSpeaker = words.some((w) => w?.speaker != null && String(w.speaker) !== '')
  const lines: string[] = []
  let cur: { spk: string; start: number; end: number; words: string[] } | null = null
  const flush = () => {
    if (cur?.words.length) {
      const n = Number(cur.spk)
      const who = hasSpeaker ? ` Speaker ${Number.isFinite(n) ? n + 1 : cur.spk}:` : ''
      lines.push(`[${clock(cur.start)}–${clock(cur.end)}]${who} ${joinWords(cur.words)}`)
    }
    cur = null
  }
  for (const w of words) {
    const word = String(w?.word ?? '').trim()
    const start = Number(w?.start), end = Number(w?.end)
    if (!word || !Number.isFinite(start)) continue
    const spk = String(w?.speaker ?? '')
    if (cur && (spk !== cur.spk || start - cur.start > 30)) flush()
    if (!cur) cur = { spk, start, end: Number.isFinite(end) ? end : start, words: [] }
    cur.words.push(word)
    if (Number.isFinite(end)) cur.end = end
    if (/[.?!。？！]$/.test(word) && cur.end - cur.start >= 8) flush()
  }
  flush()
  if (!lines.length) return null
  let out = ''
  for (const l of lines) {
    if (out.length + l.length > TIMED_MAX_CHARS) return `${out}\n… (cut here to keep the reply short; the complete timed transcript is in the JSON at transcript_url)`
    out += (out ? '\n' : '') + l
  }
  return out
}

/** For a finished transcription that ran with timestamps, its time-coded lines; otherwise null. */
async function timedTranscript(t: Transcript): Promise<string | null> {
  if (t.task !== 'transcribe' || !t.transcriptUrl) return null
  try {
    const r = await fetch(t.transcriptUrl, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return null
    return timedLines(await r.json())
  } catch {
    return null
  }
}

async function transcriptResult(h: ProfileHelpers, jobId: string, s: TaskState) {
  if (s.state !== 'completed') return { ...text(statusText(jobId, s, 'transcription')), ...(s.state === 'failed' ? { isError: true } : {}) }
  if (!s.transcript) return text(`Job ${jobId} finished. Result: ${s.urls.join('\n')}`)
  const timed = await timedTranscript(s.transcript)
  if (!timed) return text(h.transcriptText(s.transcript))
  // Header (task, duration, JSON link, notices) without the plain text, then the time-coded lines in its place.
  const header = h.transcriptText({ ...s.transcript, text: '' }).replace(/\n*\(no text\)\s*$/, '')
  return text(`${header}\n\nTIME-CODED TRANSCRIPT${/Speaker \d/.test(timed) ? ' (speaker numbers are assigned in order of first appearance)' : ''}:\n${timed}`)
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
        return await transcriptResult(h, id, await h.pollTask('audio', id, wait_seconds))
      } catch (e) { return fail(e, h.profile) }
    },
  )
}

// ── Profile: transcribe ─────────────────────────────────────────────────────────────────────────

function buildTranscribe(server: McpServer, h: ProfileHelpers) {
  server.tool(
    'transcribe',
    `Transcribes the speech in an audio file, or in the audio track of a video file, into text (model: nemotron-3.5-transcribe). Input: a public HTTPS URL that downloads the file directly; mp3, wav, m4a, aac, flac, ogg, opus, webm, mp4 or mov, up to 60 minutes and 200 MB. Options: timestamps (the transcript comes back as time-coded lines labelled by speaker, up to 8 speakers, and the JSON result adds word-level start and end times), or translation of the speech into another language instead of a transcript. Output: the transcript text, the audio duration and a link to the full result as JSON, kept for 30 days. Long recordings that are not finished within wait_seconds return a job id. Cost: ${TRANSCRIBE_PRICE}, charged to the signed-in apimodels.app balance; failed jobs and files whose length cannot be read are not charged. Whole-file transcription only, not live audio.`,
    {
      url: z.string().url().describe('Public HTTPS URL of the audio or video file.'),
      timestamps: z.boolean().optional().describe('Return the transcript as time-coded lines labelled by speaker; the JSON result also gets word-level start and end times. Cannot be combined with translate_to.'),
      translate_to: z.enum(LANGS).optional().describe('Translate the speech into this language (ISO 639-1 code) instead of transcribing it. Translation to or from English is the supported case.'),
      wait_seconds: waitParam(h, 'transcript'),
    },
    { title: 'Transcribe audio or video', ...BILLABLE },
    async ({ url, timestamps, translate_to, wait_seconds }) => {
      try {
        const { taskId, state } = await transcribeUrl(h, url, { timestamps, translate_to }, wait_seconds)
        return await transcriptResult(h, taskId, state)
      } catch (e) { return fail(e, h.profile) }
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
      } catch (e) { return fail(e, h.profile) }
    },
  )

  balanceTool(server, h)
}

// ── Profile: social ─────────────────────────────────────────────────────────────────────────────

/** Keys that carry media files or the request headers needed to fetch them: never shown by this profile. */
const MEDIA_KEYS = new Set(['variants', 'headers', 'url_list', 'urls', 'download_addr', 'play_addr'])
/** Any *_url / *Url key that points at a file or a proxy for one (media, preview, thumbnail, cover). */
const MEDIA_URL_KEY = /(resource|video|audio|download|preview|proxy|play|stream|thumbnail|thumb|cover|image|poster|avatar)_?url$/i

/** Drop media links recursively; keep captions, authors, post URLs and counts. */
export function withoutMedia(v: unknown, depth = 0): unknown {
  if (depth > 8 || v == null) return v
  if (Array.isArray(v)) return v.map((x) => withoutMedia(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (MEDIA_KEYS.has(k) || MEDIA_URL_KEY.test(k)) continue
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
    ...(d?.author ? [`Author: ${typeof d.author === 'string' ? d.author : [d.author.display_name ?? d.author.nickname ?? d.author.name, d.author.username ? `(@${d.author.username})` : ''].filter(Boolean).join(' ') || JSON.stringify(withoutMedia(d.author))}`] : []),
    ...(Number(d?.duration) > 0 ? [`Duration: ${Math.round(Number(d.duration))} s`] : []),
    ...(d?.stats ? [`Stats: ${JSON.stringify(d.stats)}`] : []),
    `Media in the post: ${medias.length ? Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') : 'none'}`,
    '',
    `Caption / title:\n${String(d?.text ?? d?.title ?? '(none)').trim() || '(none)'}`,
  ]
  return lines.join('\n')
}

/** Hosts whose links are post / video pages (never media files or CDNs). */
const PAGE_HOST = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|xiaohongshu\.com|xhslink\.com|bilibili\.com|b23\.tv|douyin\.com|weibo\.com|weibo\.cn|vimeo\.com|reddit\.com|threads\.net|kuaishou\.com|pinterest\.com|linkedin\.com|twitch\.tv|dailymotion\.com|snapchat\.com)$/i
const MEDIA_FILE = /\.(mp4|m4a|m3u8|mpd|mp3|aac|webm|mov|jpe?g|png|webp|gif|heic|avif)$/i

function pageLink(u: unknown): string | null {
  if (typeof u !== 'string') return null
  try {
    const x = new URL(u)
    return x.protocol === 'https:' && PAGE_HOST.test(x.hostname) && !MEDIA_FILE.test(x.pathname) ? x.toString() : null
  } catch {
    return null
  }
}

/** The page link of one listed post: a page URL the site gave, or one built from the video id (YouTube, Bilibili). */
export function postLink(p: any, site: string): string | null {
  for (const k of ['post_url', 'share_url', 'web_url', 'permalink', 'link', 'url']) {
    const l = pageLink(p?.[k])
    if (l) return l
  }
  const id = typeof p?.id === 'string' || typeof p?.id === 'number' ? String(p.id) : ''
  if (/youtube/i.test(site) && /^[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`
  if (/bilibili/i.test(site) && /^BV\w{10}$/.test(id)) return `https://www.bilibili.com/video/${id}`
  return null
}

const COUNT_NAMES: Record<string, string> = { digg: 'likes', like: 'likes', play: 'plays', view: 'views', comment: 'comments', share: 'shares', collect: 'saves', favorite: 'saves' }

function countsLine(stats: unknown): string {
  if (!stats || typeof stats !== 'object') return ''
  return Object.entries(stats as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && v.trim()))
    .map(([k, v]) => {
      const base = k.replace(/_count$/, '')
      return `${COUNT_NAMES[base] ?? base.replace(/_/g, ' ')} ${v}`
    })
    .join(', ')
}

function whenLine(v: unknown): string {
  if (typeof v === 'number' && v > 1e9) return new Date(v > 1e12 ? v : v * 1000).toISOString().slice(0, 10)
  return typeof v === 'string' ? v.trim() : ''
}

function authorLine(a: unknown): string {
  if (!a) return ''
  if (typeof a === 'string') return a
  const o = a as Record<string, unknown>
  const name = o.display_name ?? o.nickname ?? o.name
  const handle = o.username ? `${String(o.username).startsWith('@') ? '' : '@'}${o.username}` : ''
  return name ? [name, handle ? `(${handle})` : ''].filter(Boolean).join(' ') : handle
}

/** One page of a profile / channel listing as numbered lines: title, page link, length, age, counts. No media links. */
export function postListText(raw: unknown): string {
  const d = withoutMedia(raw) as any
  const site = String(d?.site ?? '')
  const posts: any[] = Array.isArray(d?.posts) ? d.posts : []
  const profile = authorLine(d?.profile)
  const more = d?.has_more && d?.next_cursor ? ` More posts are available; next_cursor: ${d.next_cursor}` : ' No further pages.'
  const lines = [`Site: ${site || 'unknown'}${profile ? ` · Profile: ${profile}` : ''}`, `${posts.length} post${posts.length === 1 ? '' : 's'} on this page.${posts.length ? more : ''}`, '']
  posts.forEach((p, i) => {
    const title = String(p?.title ?? p?.text ?? p?.desc ?? '').replace(/\s+/g, ' ').trim()
    const medias: any[] = Array.isArray(p?.medias) ? p.medias : []
    const dur = Number(p?.duration ?? medias.find((m) => Number(m?.duration) > 0)?.duration)
    const meta = [
      authorLine(p?.author),
      dur > 0 ? (dur < 60 ? `${Math.round(dur)} s` : `${Math.floor(dur / 60)} min ${Math.round(dur % 60)} s`) : '',
      whenLine(p?.created_at ?? p?.published_at ?? p?.create_time),
      countsLine(p?.stats),
    ].filter(Boolean)
    const link = postLink(p, site)
    lines.push(`${i + 1}. ${title ? (title.length > 300 ? `${title.slice(0, 300)}…` : title) : '(no title)'}`)
    if (link) lines.push(`   ${link}`)
    else if (p?.id != null) lines.push(`   id: ${p.id}`)
    if (meta.length) lines.push(`   ${meta.join(' · ')}`)
  })
  if (!posts.length) lines.push('No posts were found on this page.')
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
/** &#39; &amp;#39; &quot; … → characters (subtitle files are often double-escaped). */
function decodeEntities(s: string): string {
  let out = s
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
      return ENTITIES[e.toLowerCase()] ?? m
    })
  }
  return out
}

/** Subtitle file → plain text, one cue per line (json3 / VTT / SRT). */
export function subtitleToText(body: string, hint: string): string {
  return decodeEntities(subtitleToRawText(body, hint))
}

function subtitleToRawText(body: string, hint: string): string {
  const trimmed = body.trim()
  if (hint.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(trimmed)
      const events: any[] = Array.isArray(j?.events) ? j.events : Array.isArray(j?.body) ? j.body : Array.isArray(j) ? j : []
      const parts = events.map((e) => (Array.isArray(e?.segs) ? e.segs.map((s: any) => s?.utf8 ?? '').join('') : e?.content ?? e?.text ?? '')).map((s: string) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean)
      if (parts.length) return parts.join('\n')
    } catch { /* fall through to line parsing */ }
  }
  return trimmed
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT/.test(l) && !/^(NOTE|STYLE|Kind:|Language:)/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l, i, a) => l && l !== a[i - 1])
    .join(' ')
    .replace(/\s+/g, ' ')
}

/** The text of a video's published subtitles (YouTube / Bilibili), or null when it has none. $0.004. */
async function publishedSubtitles(h: ProfileHelpers, url: string, language?: string): Promise<{ text: string; language: string } | null> {
  const res = await h.apiFetch('/media/subtitles', { method: 'POST', body: JSON.stringify({ url }) })
  const d = res?.data ?? res
  const tracks: any[] = Array.isArray(d?.subtitles) ? d.subtitles : []
  if (!tracks.length) return null
  const tag = (t: any) => String(t?.language_tag ?? t?.language_code ?? t?.lang ?? t?.language ?? '')
  const pick = (language && tracks.find((t) => tag(t).toLowerCase().startsWith(language.toLowerCase()))) || tracks[0]
  const files: any[] = Array.isArray(pick?.urls) ? pick.urls : Array.isArray(pick?.formats) ? pick.formats : [pick]
  const fmtOf = (f: any) => String(f?.format ?? f?.ext ?? '').toLowerCase()
  const usable = files.filter((f) => typeof (f?.url ?? f?.download_url) === 'string')
  const file = ['json3', 'vtt', 'srt', 'json'].map((fmt) => usable.find((f) => fmtOf(f) === fmt)).find(Boolean)
  if (!file) return null
  const r = await fetch(file.url ?? file.download_url, { signal: AbortSignal.timeout(30_000) })
  if (!r.ok) return null
  const body = subtitleToText(await r.text(), fmtOf(file))
  return body ? { text: body, language: String(pick?.language_name ?? '') || tag(pick) || 'unknown' } : null
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
      } catch (e) { return fail(e, h.profile) }
    },
  )

  server.tool(
    'list_posts',
    `Lists posts from a public profile, channel, playlist or topic page (${sites}), one page at a time: each post's title or caption, its page link (given by the site, or built from the video id for YouTube and Bilibili), its length and age, and engagement counts when the site lists them, plus a cursor for the next page. Some sites, YouTube among them, list no counts; reading a single post returns them. No media links are returned. Cost: $0.02 per page, charged to the signed-in apimodels.app balance; failed lookups are not charged.`,
    {
      url: z.string().url().describe('URL of the public profile, channel, playlist or topic page.'),
      cursor: z.string().optional().describe('The next_cursor value from the previous page, to get the page after it.'),
    },
    { title: 'List social posts', ...BILLABLE },
    async ({ url, cursor }) => {
      try {
        const res = await h.apiFetch('/media/playlist', { method: 'POST', body: JSON.stringify({ url, ...(cursor ? { cursor } : {}) }) })
        return text(postListText(res?.data ?? res))
      } catch (e) { return fail(e, h.profile) }
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
        const langOf = (t: any) => String(t?.language_tag ?? t?.language_code ?? t?.lang ?? t?.language ?? '')
        const langName = (t: any) => String(t?.language_name ?? '') || langOf(t)
        const pick = (language && tracks.find((t) => langOf(t).toLowerCase().startsWith(language.toLowerCase()))) || tracks[0]
        const files: any[] = Array.isArray(pick?.urls) ? pick.urls : Array.isArray(pick?.formats) ? pick.formats : [pick]
        const fmtOf = (f: any) => String(f?.format ?? f?.ext ?? '').toLowerCase()
        const usable = files.filter((f) => typeof (f?.url ?? f?.download_url) === 'string')
        const file = ['json3', 'vtt', 'srt', 'json'].map((fmt) => usable.find((f) => fmtOf(f) === fmt)).find(Boolean)
        const fileUrl: string | undefined = file?.url ?? file?.download_url
        let body = ''
        if (fileUrl) {
          const r = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) })
          if (r.ok) body = subtitleToText(await r.text(), String(file?.format ?? file?.ext ?? fileUrl))
        }
        const langs = tracks.map((t) => `${langName(t)} (${langOf(t)})`)
        return text([
          ...(d?.title ? [`Video: ${d.title}`] : []),
          `Subtitle languages: ${langs.join(', ') || 'unknown'}; shown: ${langName(pick) || 'first track'}`,
          '',
          body || '(The subtitle file could not be read.)',
        ].join('\n'))
      } catch (e) { return fail(e, h.profile) }
    },
  )

  server.tool(
    'transcribe_post',
    `Reads one public social-media video post (${sites}) and returns the caption, author and engagement counts with the full text of what is said in the video. For YouTube and Bilibili the video's published subtitles are used when it has them; for other sites the speech is transcribed; options as for a transcription (word timestamps with speakers, or translation). No media links are returned. Videos that are not finished within wait_seconds return a job id. Cost: $0.004 to read the post, plus $0.004 for published subtitles or ${TRANSCRIBE_PRICE} for transcription, charged to the signed-in apimodels.app balance; failed steps are not charged. Some sites serve media only to their own app; those videos cannot be transcribed and nothing is charged for the attempt.`,
    {
      url: z.string().url().describe('URL of the public video post.'),
      timestamps: z.boolean().optional().describe('Return the transcript as time-coded lines labelled by speaker; the JSON result also gets word-level start and end times. Cannot be combined with translate_to.'),
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
        const site = String(d?.site ?? '').toLowerCase()
        // YouTube and Bilibili serve their media only to their own players, so their audio cannot be fetched
        // for transcription. Their published subtitles are used instead (no extra media access involved).
        const triedSubs = /youtube|bilibili/.test(site) && !timestamps && !translate_to
        if (triedSubs) {
          const sub = await publishedSubtitles(h, url)
          if (sub) return text(`${head}\n\nTRANSCRIPT — from the video's published subtitles (${sub.language}); no speech-to-text was run and no transcription was charged.\n\n${sub.text}`)
        }
        const src = speechSource(d)
        if (!src) return text(`${head}\n\nThis post has no video or audio to transcribe.`)
        try {
          const { taskId, state } = await transcribeUrl(h, src, { timestamps, translate_to }, wait_seconds)
          const body = await transcriptResult(h, taskId, state)
          return { ...body, content: [{ type: 'text' as const, text: `${head}\n\n${body.content[0].text}` }] }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (/audio duration|must be an audio file|publicly reachable|HTTP 4\d\d/i.test(msg)) {
            return { ...text(`${head}\n\nNO TRANSCRIPT — ${site || 'this site'} does not let this video be fetched for transcription (it serves the media only to its own app). Nothing was charged for the transcription. ${triedSubs ? 'This video has no published subtitles either.' : ''}`.trim()), isError: true }
          }
          throw e
        }
      } catch (e) { return fail(e, h.profile) }
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
      } catch (e) { return fail(e, h.profile) }
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
      } catch (e) { return fail(e, h.profile) }
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
      } catch (e) { return fail(e, h.profile) }
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
      } catch (e) { return fail(e, h.profile) }
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
      } catch (e) { return fail(e, h.profile) }
    },
  )

  balanceTool(server, h)
}

export function buildProfileServer(profile: Profile, h: ProfileHelpers): McpServer {
  const server = new McpServer({ name: PROFILE_INFO[profile].serverName, version: h.version })
  const hp: ProfileHelpers = { ...h, profile }
  if (profile === 'transcribe') buildTranscribe(server, hp)
  else if (profile === 'social') buildSocial(server, hp)
  else buildDesign(server, hp)
  return server
}
