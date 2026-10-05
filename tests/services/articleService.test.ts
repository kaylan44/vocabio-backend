// Unit tests of the article read service.
//
// Prisma is mocked: these tests check what the service asks for and what it hands
// back (order, filter, private fields, 404s), NOT that the queries are valid SQL.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    article: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    articleAudio: {
      findUnique: jest.fn(),
    },
  },
}));

import { prisma } from '../../src/lib/prisma';
import { getArticle, getArticleAudio, listArticles } from '../../src/services/articleService';

const mockFindMany = prisma.article.findMany as jest.Mock;
const mockFindUnique = prisma.article.findUnique as jest.Mock;
const mockAudioFindUnique = prisma.articleAudio.findUnique as jest.Mock;

const ARTICLE_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

// A row as Prisma returns it with the service's select.
const storedRow = (audio: { articleId: string } | null) => ({
  id: ARTICLE_ID,
  source: 'holaquepasa',
  lang: 'es',
  level: 'easy',
  title: 'El gato',
  excerpt: 'El gato vive en una casa.',
  url: 'https://holaquepasa.com/el-gato/',
  publishedAt: new Date('2026-10-04T12:00:00.000Z'),
  audioDurationSec: 65,
  audio,
});

describe('articleService', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('listArticles', () => {
    it('returns the newest articles first, with a stable order for pagination', async () => {
      mockFindMany.mockResolvedValue([]);

      await listArticles(undefined, 20, 10);

      const query = mockFindMany.mock.calls[0][0];
      expect(query.orderBy).toEqual([{ publishedAt: 'desc' }, { id: 'desc' }]);
      expect(query.skip).toBe(20);
      expect(query.take).toBe(10);
    });

    it('filters by level only when one is given', async () => {
      mockFindMany.mockResolvedValue([]);

      await listArticles(undefined, 0, 20);
      await listArticles('intermediate', 0, 20);

      expect(mockFindMany.mock.calls[0][0].where).toEqual({});
      expect(mockFindMany.mock.calls[1][0].where).toEqual({ level: 'intermediate' });
    });

    it('never selects the text, the audio bytes or the internal fields', async () => {
      mockFindMany.mockResolvedValue([]);

      await listArticles(undefined, 0, 20);

      const { select } = mockFindMany.mock.calls[0][0];
      // The list must stay light: no text.
      expect(select).not.toHaveProperty('content');
      // Internal to the ingestion, never sent to a client.
      expect(select).not.toHaveProperty('externalId');
      expect(select).not.toHaveProperty('audioSourceUrl');
      // Only the key of the audio row: selecting `data` would load every MP3.
      expect(select.audio).toEqual({ select: { articleId: true } });
    });

    it('replaces the audio relation by a hasAudio boolean', async () => {
      const withAudio = storedRow({ articleId: ARTICLE_ID });
      const withoutAudio = { ...storedRow(null), id: 'other' };
      mockFindMany.mockResolvedValue([withAudio, withoutAudio]);

      const articles = await listArticles(undefined, 0, 20);

      expect(articles).toHaveLength(2);
      expect(articles[0]).toMatchObject({ id: ARTICLE_ID, title: 'El gato', hasAudio: true });
      expect(articles[1]).toMatchObject({ id: 'other', hasAudio: false });
      expect(articles[0]).not.toHaveProperty('audio');
      expect(articles[1]).not.toHaveProperty('audio');
    });
  });

  // ─────────────────────────────────────────────
  describe('getArticle', () => {
    it('returns the article with its text and hasAudio', async () => {
      const content = [{ type: 'paragraph', segments: [{ text: 'El gato vive en una casa.' }] }];
      mockFindUnique.mockResolvedValue({ ...storedRow({ articleId: ARTICLE_ID }), content });

      const article = await getArticle(ARTICLE_ID);

      expect(mockFindUnique.mock.calls[0][0].where).toEqual({ id: ARTICLE_ID });
      expect(mockFindUnique.mock.calls[0][0].select.content).toBe(true);
      expect(article).toMatchObject({ id: ARTICLE_ID, content, hasAudio: true });
      expect(article).not.toHaveProperty('audio');
    });

    it('never selects the internal fields or the audio bytes', async () => {
      mockFindUnique.mockResolvedValue(storedRow(null));

      await getArticle(ARTICLE_ID);

      const { select } = mockFindUnique.mock.calls[0][0];
      expect(select).not.toHaveProperty('externalId');
      expect(select).not.toHaveProperty('audioSourceUrl');
      expect(select.audio).toEqual({ select: { articleId: true } });
    });

    it('throws a 404 when the article does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

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
      mockAudioFindUnique.mockResolvedValue(audio);

      await expect(getArticleAudio(ARTICLE_ID)).resolves.toEqual(audio);
      expect(mockAudioFindUnique.mock.calls[0][0].where).toEqual({ articleId: ARTICLE_ID });
    });

    it('throws a 404 when there is no audio for this id', async () => {
      mockAudioFindUnique.mockResolvedValue(null);

      await expect(getArticleAudio(ARTICLE_ID)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Audio not found',
      });
    });
  });
});
