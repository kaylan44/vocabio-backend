// HTTP client for the article source: Hola Qué Pasa (https://holaquepasa.com),
// short news articles written for Spanish learners, each with an MP3 reading.
//
// This file is the ONLY place that knows where the source is and how to call it.
// It does HTTP and nothing else: no HTML parsing (src/services/articleParser.ts) and
// no database access (src/services/articleIngestService.ts).
//
// Which API: the site is a WordPress, and WordPress exposes a public, read-only REST
// API at /wp-json/wp/v2. We use it instead of the RSS feed because the feed has no
// full text and a truncated summary, while the API gives the text, the level
// (categories), the image and the audio in one call.
//
// Legal context: the site publishes no reuse licence. Copying its content is only
// acceptable for private testing, which is why the whole feature sits behind the
// ARTICLES_SYNC_ENABLED flag (see src/jobs/articleScheduler.ts).

// ─────────────────────────────────────────────
// Where the source is
// ─────────────────────────────────────────────
// Constants, not environment variables: the parser is written for the HTML of this
// exact site, so pointing the client somewhere else without changing the code would
// make no sense.
const SOURCE_ORIGIN = 'https://holaquepasa.com';
export const SOURCE_HOST = 'holaquepasa.com';
const POSTS_PATH = '/wp-json/wp/v2/posts';

// WordPress category ids of the source (checked on 2026-10-05 with
// /wp-json/wp/v2/categories). "News" is the parent of the two level categories;
// filtering on it excludes the grammar and vocabulary lessons, which are other
// categories and have a different HTML shape.
export const NEWS_CATEGORY_ID = 23;
export const EASY_CATEGORY_ID = 331;
export const INTERMEDIATE_CATEGORY_ID = 332;

// An MP3 of the source weighs 1.5 to 3 MB. 10 MB leaves room while bounding what one
// download can put in memory and in the database.
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// AbortSignal.timeout covers the whole request, body included.
const API_TIMEOUT_MS = 20_000;
const AUDIO_TIMEOUT_MS = 60_000;

// Identifies us honestly to the source instead of pretending to be a browser.
const USER_AGENT = 'vocabio-backend (private test, article sync)';

// Only the fields the parser reads: the default response is several times bigger.
// `_links` and `_embedded` must be listed, otherwise `_embed` returns nothing.
const POST_FIELDS = 'id,date_gmt,link,title,categories,content,_links,_embedded';

// ─────────────────────────────────────────────
// isSourceUrl (security guard)
// ─────────────────────────────────────────────
/**
 * True only for an absolute https URL whose host is exactly the source.
 *
 * Every URL found INSIDE the remote content (MP3, image, article link) goes through
 * this check before being stored or fetched. Without it, a compromised or modified
 * source could make this server download from an arbitrary address, including
 * internal ones (server-side request forgery), or make the app load arbitrary URLs.
 *
 * `new URL()` does the parsing: comparing strings by hand (startsWith...) is how
 * `https://holaquepasa.com.evil.test` or `https://holaquepasa.com@evil.test` get through.
 */
export const isSourceUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    // username/password: `https://user@host` is legal and has no use here.
    return (
      url.protocol === 'https:' &&
      url.hostname === SOURCE_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    // new URL() throws on a malformed or relative URL.
    return false;
  }
};

// ─────────────────────────────────────────────
// fetchLatestPosts
// ─────────────────────────────────────────────
/**
 * Fetches the latest news posts of the source, newest first (WordPress default order).
 *
 * The posts are returned as `unknown`: this is remote data, and it is the parser's job
 * to check its shape field by field before trusting it.
 *
 * @param limit - Number of posts to ask for (WordPress accepts 1 to 100)
 * @throws if the source answers a non-2xx status, something that is not a JSON array,
 *         or does not answer within the timeout
 */
export const fetchLatestPosts = async (limit: number): Promise<unknown[]> => {
  // URL + searchParams instead of string concatenation: values are encoded for us.
  const url = new URL(POSTS_PATH, SOURCE_ORIGIN);
  url.searchParams.set('categories', String(NEWS_CATEGORY_ID));
  url.searchParams.set('per_page', String(limit));
  // `_embed` inlines the featured image, which would otherwise cost one call per post.
  url.searchParams.set('_embed', 'wp:featuredmedia');
  url.searchParams.set('_fields', POST_FIELDS);

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Article source answered ${response.status}`);
  }

  const body: unknown = await response.json();

  if (!Array.isArray(body)) {
    throw new Error('Article source did not return a list of posts');
  }

  return body;
};

// ─────────────────────────────────────────────
// downloadAudio
// ─────────────────────────────────────────────
/**
 * Downloads one MP3 of the source into memory.
 *
 * The URL comes from remote content, so nothing is assumed about it:
 * - it must pass isSourceUrl, checked BEFORE any request is made;
 * - redirects are refused: a valid URL must not be able to send us to another host;
 * - the response must declare an audio type;
 * - the size is capped twice: on Content-Length (cheap, but the header can be absent
 *   or wrong) and while reading the body (the only check that cannot be bypassed).
 *
 * @returns the file and its normalised MIME type (e.g. 'audio/mpeg')
 * @throws on any refusal above, on a non-2xx status or on a timeout
 */
export const downloadAudio = async (url: string): Promise<{ data: Buffer; mimeType: string }> => {
  if (!isSourceUrl(url)) {
    throw new Error('Audio URL is not an https URL of the article source');
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'error',
    signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Audio download answered ${response.status}`);
  }

  // 'audio/mpeg; charset=…' → 'audio/mpeg'. The strict pattern matters because this
  // value is stored, then sent back as the Content-Type header of our own audio route.
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(mimeType)) {
    throw new Error('Audio download is not an audio file');
  }

  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_AUDIO_BYTES) {
    throw new Error('Audio file is too large');
  }

  if (!response.body) {
    throw new Error('Audio download has no body');
  }

  // Read chunk by chunk so we can stop as soon as the cap is passed, instead of
  // letting `response.arrayBuffer()` load a file of any size.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    received += value.byteLength;
    if (received > MAX_AUDIO_BYTES) {
      // Closes the connection: the rest of the file is never downloaded.
      await reader.cancel();
      throw new Error('Audio file is too large');
    }

    chunks.push(value);
  }

  if (received === 0) {
    throw new Error('Audio download is empty');
  }

  return { data: Buffer.concat(chunks), mimeType };
};
