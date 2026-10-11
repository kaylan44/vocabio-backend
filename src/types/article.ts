// Shared article types: the allowed levels, the structure of the text, and what the
// client receives. See src/types/user.ts for why such shapes live in src/types/.
//
// Import from this file directly: articleParser.ts does not re-export anything from it.

// ─────────────────────────────────────────────
// Level and text structure
// ─────────────────────────────────────────────
// `as const` + derived type: same trick as QUIZ_MODES in src/types/quiz.ts. The route
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

// ─────────────────────────────────────────────
// What the client receives
// ─────────────────────────────────────────────
// The `select` that must match ArticleSummary is SUMMARY_SELECT in
// src/repositories/articleRepository.ts.
//
// Why `level` is a plain string and `content` is `unknown` here, while ArticleLevel
// and ArticleBlock[] exist just above: these two interfaces describe what is READ
// from the database. The columns are a String and a Json, which guarantee nothing
// about the value: an old row, or a row written by a newer version of the backend,
// can hold something else. Typing them precisely would need a cast, i.e. a promise
// the compiler cannot check. The precise types are used where the value IS checked:
// on the write side (the parser produced it) and for the level filter (the route
// validated it).
export interface ArticleSummary {
  id: string;
  source: string;
  lang: string;
  level: string | null;
  title: string;
  excerpt: string;
  url: string;
  publishedAt: Date;
  audioDurationSec: number | null;
  // Whether an audio row exists: the client only needs to know whether it can call
  // the audio route.
  hasAudio: boolean;
}

export interface ArticleDetail extends ArticleSummary {
  content: unknown; // the JSON stored at ingestion (ArticleBlock[] when written by us)
}

export interface ArticleAudioFile {
  data: Buffer;
  mimeType: string;
  size: number;
}
