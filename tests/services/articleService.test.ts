// Unit tests of the article read service.
//
// The repository is mocked: these tests check what the service asks for (page, level
// filter), that it hands back what it was given, and the 404s.
//
// What is NOT checked here any more, because it now lives in the repository: the sort
// order, which fields are selected (no text in the list, never the internal fields or
// the audio bytes) and the `hasAudio` boolean. Those tests are in
// tests/repositories/articleRepository.test.ts.

jest.mock('../../src/repositories/articleRepository', () => ({
  findArticleSummaries: jest.fn(),
  findArticleById: jest.fn(),
  findArticleAudio: jest.fn(),
}));

import {
  findArticleAudio,
  findArticleById,
  findArticleSummaries,
} from '../../src/repositories/articleRepository';
import { getArticle, getArticleAudio, listArticles } from '../../src/services/articleService';

const mockFindSummaries = findArticleSummaries as jest.Mock;
const mockFindById = findArticleById as jest.Mock;
const mockFindAudio = findArticleAudio as jest.Mock;

const ARTICLE_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

// An article summary as the repository returns it.
const summary = (hasAudio: boolean) => ({
  id: ARTICLE_ID,
  source: 'holaquepasa',
  lang: 'es',
  level: 'easy',
  title: 'El gato',
  excerpt: 'El gato vive en una casa.',
  url: 'https://holaquepasa.com/el-gato/',
  publishedAt: new Date('2026-10-04T12:00:00.000Z'),
  audioDurationSec: 65,
  hasAudio,
});

describe('articleService', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('listArticles', () => {
    it('asks for the requested page', async () => {
      mockFindSummaries.mockResolvedValue([]);

      await listArticles(undefined, 20, 10);

      // offset then limit: swapped, the app would skip 10 articles and receive 20.
      expect(mockFindSummaries).toHaveBeenCalledWith(undefined, 20, 10);
    });

    it('filters by level only when one is given', async () => {
      mockFindSummaries.mockResolvedValue([]);

      await listArticles(undefined, 0, 20);
      await listArticles('intermediate', 0, 20);

      expect(mockFindSummaries.mock.calls[0][0]).toBeUndefined();
      expect(mockFindSummaries.mock.calls[1][0]).toBe('intermediate');
    });

    it('returns the summaries as the repository gives them, in the same order', async () => {
      const withAudio = summary(true);
      const withoutAudio = { ...summary(false), id: 'other' };
      mockFindSummaries.mockResolvedValue([withAudio, withoutAudio]);

      const articles = await listArticles(undefined, 0, 20);

      // Nothing is added on the way: a field added here would bypass the list of
      // fields allowed to leave the server, which the repository owns.
      expect(articles).toEqual([withAudio, withoutAudio]);
    });
  });

  // ─────────────────────────────────────────────
  describe('getArticle', () => {
    it('returns the article with its text and hasAudio', async () => {
      const content = [{ type: 'paragraph', segments: [{ text: 'El gato vive en una casa.' }] }];
      const stored = { ...summary(true), content };
      mockFindById.mockResolvedValue(stored);

      const article = await getArticle(ARTICLE_ID);

      expect(mockFindById).toHaveBeenCalledWith(ARTICLE_ID);
      expect(article).toEqual(stored);
    });

    it('throws a 404 when the article does not exist', async () => {
      mockFindById.mockResolvedValue(null);

      await expect(getArticle(ARTICLE_ID)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Article not found',
      });
    });
  });

  // ─────────────────────────────────────────────
  describe('getArticleAudio', () => {
    it('returns the bytes, the type and the size of the audio', async () => {
      const audio = { data: Buffer.from([1, 2, 3]), mimeType: 'audio/mpeg', size: 3 };
      mockFindAudio.mockResolvedValue(audio);

      await expect(getArticleAudio(ARTICLE_ID)).resolves.toEqual(audio);
      expect(mockFindAudio).toHaveBeenCalledWith(ARTICLE_ID);
    });

    it('throws a 404 when there is no audio for this id', async () => {
      mockFindAudio.mockResolvedValue(null);

      await expect(getArticleAudio(ARTICLE_ID)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Audio not found',
      });
    });
  });
});
