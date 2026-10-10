// Article repository: every query on the Article and ArticleAudio tables.
//
// Same rule as the other repositories (see userRepository.ts): Prisma only. What is
// NOT here: the 404s (articleService), and everything the ingestion decides, such as
// which article is new, which is too old, what counts as a failure
// (articleIngestService).
//
// Two kinds of callers, kept apart in this file:
//   - the read side (the app, through articleService), which must never receive the
//     internal fields nor load audio bytes by accident;
//   - the ingestion job (articleIngestService), the only writer.
//
// Why `level` is a plain string and `content` is `unknown` here, while the services
// have precise types for them (ArticleLevel, ArticleBlock[]): those types belong to
// the parser, in src/services/. Importing them would make this layer depend on the
// one above it. The database stores a string and a JSON value; saying what they MEAN
// is the job of the services.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toRepositoryError } from './errors';

// ─────────────────────────────────────────────
// Shapes exchanged with the services
// ─────────────────────────────────────────────

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
  content: unknown; // the JSON stored at ingestion (ArticleBlock[], see articleParser.ts)
}

export interface ArticleAudioFile {
  data: Buffer;
  mimeType: string;
  size: number;
}

// What the ingestion needs to know about an article it may already have.
export interface StoredArticleRef {
  id: string;
  externalId: string;
  hasAudio: boolean;
}

export interface NewArticleAudio {
  data: Buffer;
  mimeType: string;
}

export interface NewArticle {
  source: string;
  externalId: string;
  lang: string;
  level: string | null;
  title: string;
  excerpt: string;
  content: unknown; // plain JSON: arrays of objects of strings
  url: string;
  audioSourceUrl: string | null;
  audioDurationSec: number | null;
  publishedAt: Date;
}

// ─────────────────────────────────────────────
// What may leave the server
// ─────────────────────────────────────────────
// An explicit `select`, not "everything minus a few fields": a column added to the
// table later stays private until someone decides to list it here.
// Deliberately absent: externalId and audioSourceUrl (internal to the ingestion).
//
// `audio` only selects its key. We need to know whether the row exists (hasAudio),
// never the MP3 itself, which is megabytes.
const SUMMARY_SELECT = {
  id: true,
  source: true,
  lang: true,
  level: true,
  title: true,
  excerpt: true,
  url: true,
  publishedAt: true,
  audioDurationSec: true,
  audio: { select: { articleId: true } },
} as const;

// Replaces the `audio` relation by a boolean. The relation is how Prisma lets us ask
// "is there an audio row?"; nothing above this file needs to see it.
const withHasAudio = <Row extends { audio: { articleId: string } | null }>(row: Row) => {
  const { audio, ...article } = row;
  return { ...article, hasAudio: audio !== null };
};

// ─────────────────────────────────────────────
// Read side
// ─────────────────────────────────────────────

/**
 * One page of articles, newest first, without their text.
 *
 * @param level - Optional filter. Without it every article is returned, including
 *                those whose level is unknown (null).
 */
export const findArticleSummaries = async (
  level: string | undefined,
  offset: number,
  limit: number
): Promise<ArticleSummary[]> => {
  const rows = await prisma.article.findMany({
    where: level ? { level } : {},
    // `id` as a tie-breaker: two articles with the same publishedAt must always come
    // in the same order, otherwise offset pagination can repeat or skip one.
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: limit,
    select: SUMMARY_SELECT,
  });

  return rows.map(withHasAudio);
};

/**
 * One article with its text, or null if no article has this id.
 */
export const findArticleById = async (articleId: string): Promise<ArticleDetail | null> => {
  const row = await prisma.article.findUnique({
    where: { id: articleId },
    select: { ...SUMMARY_SELECT, content: true },
  });

  return row ? withHasAudio(row) : null;
};

/**
 * The MP3 of an article, or null if the article does not exist or has no audio.
 * This is the ONLY query of the project that loads audio bytes.
 */
export const findArticleAudio = async (articleId: string): Promise<ArticleAudioFile | null> => {
  return prisma.articleAudio.findUnique({
    where: { articleId },
    select: { data: true, mimeType: true, size: true },
  });
};

// ─────────────────────────────────────────────
// Ingestion side
// ─────────────────────────────────────────────

/**
 * Among the given posts of a source, the ones already stored, and whether each has
 * its audio.
 *
 * One query for the whole batch instead of one per article. `audio` only selects
 * the key: we need to know whether the row exists, not to load the MP3.
 */
export const findStoredByExternalIds = async (
  source: string,
  externalIds: string[]
): Promise<StoredArticleRef[]> => {
  const rows = await prisma.article.findMany({
    where: {
      source,
      externalId: { in: externalIds },
    },
    select: { id: true, externalId: true, audio: { select: { articleId: true } } },
  });

  return rows.map(withHasAudio);
};

/**
 * Stores an article, with its audio when there is one.
 *
 * Nested create: the article and its audio are written in ONE transaction.
 * We can never end up with an audio row pointing to nothing.
 *
 * @param audio - null stores the article alone; addArticleAudio can complete it later
 * @throws UniqueConstraintError if this (source, externalId) is already stored
 */
export const createArticle = async (
  article: NewArticle,
  audio: NewArticleAudio | null
): Promise<void> => {
  try {
    await prisma.article.create({
      data: {
        source: article.source,
        externalId: article.externalId,
        lang: article.lang,
        level: article.level,
        title: article.title,
        excerpt: article.excerpt,
        // Prisma's Json input type does not accept an arbitrary value directly (it
        // wants an index signature). The value IS plain JSON: arrays of objects of
        // strings. The cast lives here so no service has to know a Prisma type.
        content: article.content as Prisma.InputJsonValue,
        url: article.url,
        audioSourceUrl: article.audioSourceUrl,
        audioDurationSec: article.audioDurationSec,
        publishedAt: article.publishedAt,
        ...(audio && {
          audio: {
            // `size` duplicates data.length (see ArticleAudio in schema.prisma).
            create: { data: audio.data, mimeType: audio.mimeType, size: audio.data.length },
          },
        }),
      },
    });
  } catch (error) {
    throw toRepositoryError(error);
  }
};

/**
 * Adds the audio of an article stored earlier without it.
 *
 * @throws UniqueConstraintError if the article already has an audio
 */
export const addArticleAudio = async (articleId: string, audio: NewArticleAudio): Promise<void> => {
  try {
    await prisma.articleAudio.create({
      data: {
        articleId,
        data: audio.data,
        mimeType: audio.mimeType,
        size: audio.data.length,
      },
    });
  } catch (error) {
    throw toRepositoryError(error);
  }
};

/**
 * Deletes the articles published before `cutoff`. Their audio goes with them, by
 * cascade (see ArticleAudio in schema.prisma).
 *
 * @returns the number of articles deleted
 */
export const deleteArticlesOlderThan = async (cutoff: Date): Promise<number> => {
  const { count } = await prisma.article.deleteMany({ where: { publishedAt: { lt: cutoff } } });
  return count;
};
