// Article service (read side).
//
// What the app reads: the list of articles, one article with its text, and the audio
// of one article. Articles are written by the ingestion job only
// (articleIngestService.ts); nothing here modifies them.
//
// Articles are the same for every user: unlike quiz results, there is no owner to
// check. The protection is the authentication on the routes, plus the rule below on
// which fields leave the server.

import * as articleRepository from '../repositories/articleRepository';
import { ArticleLevel } from '../types/article';

// Same error convention as assertParticipant (conversationService.ts): a plain Error
// carrying a `statusCode`, which handleError() turns into the HTTP status.
const httpError = (statusCode: number, message: string): Error => {
  const err = new Error(message);
  (err as any).statusCode = statusCode;
  return err;
};

// Which fields are returned to the client is decided in articleRepository.ts
// (SUMMARY_SELECT): the internal fields and the audio bytes never reach this file.

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
  return articleRepository.findArticleSummaries(level, offset, limit);
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
  const article = await articleRepository.findArticleById(articleId);

  if (!article) {
    throw httpError(404, 'Article not found');
  }

  return article;
};

// ─────────────────────────────────────────────
// getArticleAudio
// ─────────────────────────────────────────────
/**
 * Returns the MP3 of an article. This is the ONLY read of the project that loads
 * audio bytes.
 *
 * @throws 404 if the article does not exist or has no audio. Both cases give the same
 *         answer on purpose: the client does the same thing either way (no player).
 */
export const getArticleAudio = async (articleId: string) => {
  const audio = await articleRepository.findArticleAudio(articleId);

  if (!audio) {
    throw httpError(404, 'Audio not found');
  }

  return audio;
};
