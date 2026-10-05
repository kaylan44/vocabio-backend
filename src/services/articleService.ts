// Article service (read side).
//
// What the app reads: the list of articles, one article with its text, and the audio
// of one article. Articles are written by the ingestion job only
// (articleIngestService.ts); nothing here modifies them.
//
// Articles are the same for every user: unlike quiz results, there is no owner to
// check. The protection is the authentication on the routes, plus the rule below on
// which fields leave the server.

import { prisma } from '../lib/prisma';
import { ArticleLevel } from './articleParser';

// Same error convention as assertParticipant (conversationService.ts): a plain Error
// carrying a `statusCode`, which handleError() turns into the HTTP status.
const httpError = (statusCode: number, message: string): Error => {
  const err = new Error(message);
  (err as any).statusCode = statusCode;
  return err;
};

// ─────────────────────────────────────────────
// What is returned to the client
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
  imageUrl: true,
  publishedAt: true,
  audioDurationSec: true,
  audio: { select: { articleId: true } },
} as const;

// Replaces the `audio` relation by a boolean: the client only needs to know whether
// it can call the audio route.
const withHasAudio = <Row extends { audio: { articleId: string } | null }>(row: Row) => {
  const { audio, ...article } = row;
  return { ...article, hasAudio: audio !== null };
};

// ─────────────────────────────────────────────
// listArticles
// ─────────────────────────────────────────────
/**
 * Lists the articles, newest first, without their text.
 *
 * @param level  - Optional filter. Articles whose level is unknown (null) are only
 *                 returned when no filter is given.
 * @param offset - Number of articles to skip (already bounded by the route)
 * @param limit  - Maximum number of articles (already bounded by the route)
 */
export const listArticles = async (
  level: ArticleLevel | undefined,
  offset: number,
  limit: number
) => {
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

// ─────────────────────────────────────────────
// getArticle
// ─────────────────────────────────────────────
/**
 * Returns one article with its text (`content`: ArticleBlock[], see articleParser.ts).
 *
 * @throws 404 if no article has this id (unknown, or purged since the list was loaded)
 */
export const getArticle = async (articleId: string) => {
  const row = await prisma.article.findUnique({
    where: { id: articleId },
    select: { ...SUMMARY_SELECT, content: true },
  });

  if (!row) {
    throw httpError(404, 'Article not found');
  }

  return withHasAudio(row);
};

// ─────────────────────────────────────────────
// getArticleAudio
// ─────────────────────────────────────────────
/**
 * Returns the MP3 of an article. This is the ONLY query of the project that loads
 * audio bytes.
 *
 * @throws 404 if the article does not exist or has no audio. Both cases give the same
 *         answer on purpose: the client does the same thing either way (no player).
 */
export const getArticleAudio = async (articleId: string) => {
  const audio = await prisma.articleAudio.findUnique({
    where: { articleId },
    select: { data: true, mimeType: true, size: true },
  });

  if (!audio) {
    throw httpError(404, 'Audio not found');
  }

  return audio;
};
