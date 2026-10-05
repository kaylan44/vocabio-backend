// Article parser.
//
// Turns one post of the source's WordPress API into the fields we store. Pure
// functions: no network, no database, nothing but the input. This is the part most
// likely to break the day the site changes its HTML, so it is also the easiest part
// to test (tests/services/articleParser.test.ts).
//
// Shape of `content.rendered` at the source (checked on 2026-10-05):
//
//   <div itemscope itemtype="http://schema.org/AudioObject">     ← audio metadata
//     <meta itemprop="duration" content="PT3M52S" />
//     <meta itemprop="contentUrl" content="https://…/file.mp3" />
//     <div class="powerpress_player">…</div>                      ← their audio player
//   </div>
//   <p class="powerpress_links">Podcast: …</p>                    ← subscribe links
//   <figure class="wp-block-image">…</figure>
//   <p>…</p> <p>…</p>                                             ← THE ARTICLE
//   <section class="wp-block-uagb-section">…</section>            ← grammar links
//
// So the article is: the <p> elements that are direct children of the root, minus the
// "powerpress" one. That single rule drops the player, the image and the trailing
// section, without having to list everything we do not want.
//
// Inside the paragraphs, some phrases carry a vocabulary tooltip:
//
//   su amor a <span class="su-tooltip-button" aria-describedby="X">los coches</span>
//   <span id="X" class="su-tooltip" style="display:none">…
//     <span class="su-tooltip-content">electric cars</span>…
//   </span>.
//
// The visible phrase and its hidden English gloss become one segment
// `{ text, gloss }`. The hidden span must never be emitted as text.

import { parse, HTMLElement, Node, NodeType } from 'node-html-parser';
import { EASY_CATEGORY_ID, INTERMEDIATE_CATEGORY_ID, isSourceUrl } from '../lib/holaQuePasa';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
// `as const` + derived type: same trick as QUIZ_MODES in quizService.ts. The route
// validates the `level` query parameter against this list.
export const ARTICLE_LEVELS = ['easy', 'intermediate'] as const;
export type ArticleLevel = (typeof ARTICLE_LEVELS)[number];

// A piece of a paragraph. `gloss` is present when the source explains the phrase
// (in English: the site targets English speakers).
export interface ArticleSegment {
  text: string;
  gloss?: string;
}

// `type` is always 'paragraph' today. It is there so that a heading or a list can be
// added later without changing the shape the app already reads.
export interface ArticleBlock {
  type: 'paragraph';
  segments: ArticleSegment[];
}

export interface ParsedArticle {
  externalId: string;
  title: string;
  url: string;
  level: ArticleLevel | null;
  publishedAt: Date;
  imageUrl: string | null;
  audioSourceUrl: string | null;
  audioDurationSec: number | null;
  excerpt: string;
  content: ArticleBlock[];
}

// Length of the excerpt shown in the list, in characters.
export const EXCERPT_MAX_LENGTH = 200;
// Bounds on what one article can store. A real article has ~10 paragraphs and a
// title under 100 characters; these only stop a broken or hostile page from filling
// the database.
const MAX_TITLE_LENGTH = 300;
const MAX_BLOCKS = 200;
// Longest audio we accept to describe (the value is only displayed).
const MAX_DURATION_SEC = 6 * 60 * 60;

// ─────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────

// Same guard as in routes/quizSessions.ts: `typeof null` is 'object'.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Collapses every run of whitespace (spaces, tabs, line breaks, non-breaking spaces)
// into ONE space, without trimming: the space between two segments must survive.
const collapseWhitespace = (text: string): string => text.replace(/[\s ]+/g, ' ');

// HTML fragment → plain text with entities decoded ('&#8220;' → '“').
const htmlToText = (html: string): string => collapseWhitespace(parse(html).text).trim();

const hasClass = (element: HTMLElement, className: string): boolean =>
  element.classList.contains(className);

const isElement = (node: Node): node is HTMLElement => node.nodeType === NodeType.ELEMENT_NODE;

/**
 * 'PT3M52S' → 232. ISO 8601 duration as written by the source's podcast plugin.
 * Returns null for anything else rather than guessing.
 */
export const parseIsoDuration = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^PT(?:(\d{1,3})H)?(?:(\d{1,3})M)?(?:(\d{1,5})S)?$/.exec(value.trim());
  // 'PT' alone matches the pattern with every group empty: reject it.
  if (!match || (!match[1] && !match[2] && !match[3])) {
    return null;
  }

  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);

  return seconds > 0 && seconds <= MAX_DURATION_SEC ? seconds : null;
};

// ─────────────────────────────────────────────
// Paragraph → segments
// ─────────────────────────────────────────────

// Adds a piece of text to the segments. Two consecutive plain pieces are merged:
// `<strong>` or `<a>` inside a sentence must not cut it into several segments.
const pushSegment = (segments: ArticleSegment[], text: string, gloss?: string): void => {
  if (text === '') {
    return;
  }

  const last = segments[segments.length - 1];
  if (!gloss && last && !last.gloss) {
    last.text = collapseWhitespace(last.text + text);
    return;
  }

  segments.push(gloss ? { text, gloss } : { text });
};

// Depth-first walk of one paragraph, in reading order.
const collectSegments = (
  node: Node,
  glosses: Map<string, string>,
  segments: ArticleSegment[]
): void => {
  for (const child of node.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      pushSegment(segments, collapseWhitespace(child.text));
      continue;
    }

    if (!isElement(child)) {
      // HTML comment: nothing to read.
      continue;
    }

    const tag = child.tagName?.toLowerCase();

    // The HTML library does not parse the inside of these elements: it hands it back
    // as raw text. Without this skip, `<noscript><img …></noscript>` (written by
    // lazy-loading plugins) would put literal markup in the middle of the article.
    if (tag === 'script' || tag === 'style' || tag === 'noscript') {
      continue;
    }

    // The hidden tooltip. Its text was already read into `glosses`; emitting it here
    // would paste the English gloss in the middle of the Spanish sentence.
    if (hasClass(child, 'su-tooltip')) {
      continue;
    }

    if (hasClass(child, 'su-tooltip-button')) {
      const raw = collapseWhitespace(child.text);
      const gloss = glosses.get(child.getAttribute('aria-describedby') ?? '');
      // The phrase itself is trimmed (a gloss applies to words, not to spaces), but a
      // space at its edges is NOT thrown away: it is handed to the surrounding text.
      // Otherwise `a<span> los coches </span>y` would come out as "alos cochesy" when
      // the only space between the words is inside the span.
      if (raw.startsWith(' ')) {
        pushSegment(segments, ' ');
      }
      // No gloss found (markup changed?): keep the phrase as ordinary text rather
      // than losing a piece of the sentence.
      pushSegment(segments, raw.trim(), gloss);
      if (raw.endsWith(' ')) {
        pushSegment(segments, ' ');
      }
      continue;
    }

    if (tag === 'br') {
      pushSegment(segments, ' ');
      continue;
    }

    // <strong>, <em>, <a>…: formatting is dropped, the text is kept.
    collectSegments(child, glosses, segments);
  }
};

const parseParagraph = (paragraph: HTMLElement): ArticleBlock | null => {
  // First pass: tooltip id → gloss. The button points to its tooltip with
  // aria-describedby, which is more reliable than "the next sibling".
  const glosses = new Map<string, string>();
  for (const tooltip of paragraph.querySelectorAll('.su-tooltip')) {
    const id = tooltip.getAttribute('id');
    const content = tooltip.querySelector('.su-tooltip-content');
    const gloss = content ? collapseWhitespace(content.text).trim() : '';
    if (id && gloss) {
      glosses.set(id, gloss);
    }
  }

  const segments: ArticleSegment[] = [];
  collectSegments(paragraph, glosses, segments);

  // Trim the paragraph as a whole: only the outer edges, never between segments.
  if (segments.length > 0) {
    segments[0].text = segments[0].text.trimStart();
    segments[segments.length - 1].text = segments[segments.length - 1].text.trimEnd();
  }

  const nonEmpty = segments.filter((segment) => segment.text !== '');

  return nonEmpty.length > 0 ? { type: 'paragraph', segments: nonEmpty } : null;
};

const blockToText = (block: ArticleBlock): string =>
  block.segments.map((segment) => segment.text).join('');

/**
 * Beginning of the article as plain text, cut on a word boundary.
 * Exported for the tests.
 */
export const buildExcerpt = (blocks: ArticleBlock[]): string => {
  const text = collapseWhitespace(blocks.map(blockToText).join(' ')).trim();

  if (text.length <= EXCERPT_MAX_LENGTH) {
    return text;
  }

  const cut = text.slice(0, EXCERPT_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  // No space at all (one endless word): cut hard rather than return nothing.
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

// ─────────────────────────────────────────────
// Fields outside the HTML
// ─────────────────────────────────────────────

const parseLevel = (categories: unknown): ArticleLevel | null => {
  if (!Array.isArray(categories)) {
    return null;
  }
  if (categories.includes(EASY_CATEGORY_ID)) {
    return 'easy';
  }
  if (categories.includes(INTERMEDIATE_CATEGORY_ID)) {
    return 'intermediate';
  }
  return null;
};

// `date_gmt` looks like '2026-10-03T12:00:00': UTC, but WITHOUT the 'Z'. Parsed as
// is, JavaScript would read it as local time of the server. We add the 'Z' ourselves.
const parsePublishedAt = (dateGmt: unknown): Date | null => {
  if (typeof dateGmt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dateGmt)) {
    return null;
  }
  const date = new Date(`${dateGmt}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

// _embedded['wp:featuredmedia'][0].source_url, each level checked before being read.
const parseImageUrl = (embedded: unknown): string | null => {
  if (!isPlainObject(embedded)) {
    return null;
  }
  const media = embedded['wp:featuredmedia'];
  if (!Array.isArray(media) || !isPlainObject(media[0])) {
    return null;
  }
  const sourceUrl = media[0].source_url;
  return isSourceUrl(sourceUrl) ? sourceUrl : null;
};

// ─────────────────────────────────────────────
// parsePost
// ─────────────────────────────────────────────
/**
 * Turns one post of the source API into a ParsedArticle.
 *
 * Must NEVER throw: the input is remote data of unknown shape, and one bad post must
 * not stop the ingestion of the others. Every value is type-checked before its fields
 * are read; the try/catch is only a last safety net around the HTML library.
 *
 * @returns null when the post cannot give a usable article (no id, no title, no date,
 *          no link back to the source, or no text). An article WITHOUT audio or image
 *          is still valid.
 */
export const parsePost = (post: unknown): ParsedArticle | null => {
  try {
    if (!isPlainObject(post)) {
      return null;
    }

    // WordPress ids are positive integers. Stored as a string: for us it is an opaque
    // key, and another source may not use numbers.
    if (typeof post.id !== 'number' || !Number.isInteger(post.id) || post.id <= 0) {
      return null;
    }

    // The link is required: it is how the app credits the source.
    if (!isSourceUrl(post.link)) {
      return null;
    }

    const publishedAt = parsePublishedAt(post.date_gmt);
    if (!publishedAt) {
      return null;
    }

    // `title.rendered` is HTML-escaped by WordPress ('&#8220;Hola&#8221;').
    const rawTitle = isPlainObject(post.title) ? post.title.rendered : null;
    const title = typeof rawTitle === 'string' ? htmlToText(rawTitle).slice(0, MAX_TITLE_LENGTH) : '';
    if (title === '') {
      return null;
    }

    const html = isPlainObject(post.content) ? post.content.rendered : null;
    if (typeof html !== 'string') {
      return null;
    }

    const root = parse(html);

    // Audio metadata. A URL that is not on the source's host is treated as "no
    // audio": the article is kept, nothing is downloaded.
    const audioUrl = root.querySelector('meta[itemprop="contentUrl"]')?.getAttribute('content');
    const audioSourceUrl = isSourceUrl(audioUrl) ? audioUrl : null;
    const audioDurationSec = audioSourceUrl
      ? parseIsoDuration(root.querySelector('meta[itemprop="duration"]')?.getAttribute('content'))
      : null;

    // The article itself: top-level <p> only (see the file header).
    const content: ArticleBlock[] = [];
    for (const child of root.childNodes) {
      if (!isElement(child) || child.tagName?.toLowerCase() !== 'p') {
        continue;
      }
      // classNames, not classList: we match a prefix ('powerpress_links',
      // 'powerpress_subscribe_links'…), whatever the plugin calls it next.
      if (/(^|\s)powerpress/.test(child.classNames)) {
        continue;
      }

      const block = parseParagraph(child);
      if (block) {
        content.push(block);
      }
      if (content.length >= MAX_BLOCKS) {
        break;
      }
    }

    if (content.length === 0) {
      return null;
    }

    return {
      externalId: String(post.id),
      title,
      url: post.link,
      level: parseLevel(post.categories),
      publishedAt,
      imageUrl: parseImageUrl(post._embedded),
      audioSourceUrl,
      audioDurationSec,
      excerpt: buildExcerpt(content),
      content,
    };
  } catch {
    return null;
  }
};
