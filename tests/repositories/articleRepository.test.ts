// Unit tests of the article repository.
//
// Prisma is mocked: these tests check WHICH query is sent (above all: which fields are
// selected, since this file decides what may leave the server) and how the result is
// reshaped. They do NOT check that the query is valid SQL. There is no test against a
// real database in this project yet.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    article: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    articleAudio: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

// '@prisma/client' itself is NOT mocked: we need the real error class to build a
// genuine P2002 error.
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/lib/prisma';
import {
  addArticleAudio,
  createArticle,
  deleteArticlesOlderThan,
  findArticleAudio,
  findArticleById,
  findArticleSummaries,
  findStoredByExternalIds,
} from '../../src/repositories/articleRepository';
import { UniqueConstraintError } from '../../src/repositories/errors';

const mockFindMany = prisma.article.findMany as jest.Mock;
const mockFindUnique = prisma.article.findUnique as jest.Mock;
const mockCreate = prisma.article.create as jest.Mock;
const mockDeleteMany = prisma.article.deleteMany as jest.Mock;
const mockAudioFindUnique = prisma.articleAudio.findUnique as jest.Mock;
const mockAudioCreate = prisma.articleAudio.create as jest.Mock;

const ARTICLE_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

// A row as Prisma returns it with the repository's select.
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

const newArticle = {
  source: 'holaquepasa',
  externalId: '74003',
  lang: 'es',
  level: 'easy',
  title: 'El gato',
  excerpt: 'El gato vive en una casa.',
  content: [{ type: 'paragraph', segments: [{ text: 'El gato vive en una casa.' }] }],
  url: 'https://holaquepasa.com/el-gato/',
  audioSourceUrl: 'https://holaquepasa.com/wp-content/uploads/el-gato.mp3',
  audioDurationSec: 65,
  publishedAt: new Date('2026-10-04T12:00:00.000Z'),
};

const MP3 = { data: Buffer.from([0xff, 0xf3, 0x84, 0x01]), mimeType: 'audio/mpeg' };

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('articleRepository', () => {
  beforeEach(() => jest.resetAllMocks());

  // ─────────────────────────────────────────────
  describe('findArticleSummaries', () => {
    it('returns the newest articles first, with a stable order for pagination', async () => {
      mockFindMany.mockResolvedValue([]);

      await findArticleSummaries(undefined, 20, 10);

      const query = mockFindMany.mock.calls[0][0];
      // `id` breaks ties: without it, offset pagination can repeat or skip an article.
      expect(query.orderBy).toEqual([{ publishedAt: 'desc' }, { id: 'desc' }]);
      expect(query.skip).toBe(20);
      expect(query.take).toBe(10);
    });

    it('filters by level only when one is given', async () => {
      mockFindMany.mockResolvedValue([]);

      await findArticleSummaries(undefined, 0, 10);
      await findArticleSummaries('intermediate', 0, 10);

      expect(mockFindMany.mock.calls[0][0].where).toEqual({});
      expect(mockFindMany.mock.calls[1][0].where).toEqual({ level: 'intermediate' });
    });

    it('never selects the text, the audio bytes or the internal fields', async () => {
      mockFindMany.mockResolvedValue([]);

      await findArticleSummaries(undefined, 0, 10);

      const { select } = mockFindMany.mock.calls[0][0];
      expect(select).not.toHaveProperty('content');
      expect(select).not.toHaveProperty('externalId');
      expect(select).not.toHaveProperty('audioSourceUrl');
      // Only the key of the audio row: enough to know it exists, no MP3 loaded.
      expect(select.audio).toEqual({ select: { articleId: true } });
    });

    it('replaces the audio relation by a hasAudio boolean', async () => {
      mockFindMany.mockResolvedValue([
        storedRow({ articleId: ARTICLE_ID }),
        { ...storedRow(null), id: 'other' },
      ]);

      const articles = await findArticleSummaries(undefined, 0, 10);

      expect(articles[0]).toMatchObject({ id: ARTICLE_ID, title: 'El gato', hasAudio: true });
      expect(articles[1]).toMatchObject({ id: 'other', hasAudio: false });
      expect(articles[0]).not.toHaveProperty('audio');
    });
  });

  // ─────────────────────────────────────────────
  describe('findArticleById', () => {
    it('returns the article with its text and hasAudio', async () => {
      const content = [{ type: 'paragraph', segments: [{ text: 'El gato vive en una casa.' }] }];
      mockFindUnique.mockResolvedValue({ ...storedRow({ articleId: ARTICLE_ID }), content });

      const article = await findArticleById(ARTICLE_ID);

      expect(mockFindUnique.mock.calls[0][0].where).toEqual({ id: ARTICLE_ID });
      expect(article).toMatchObject({ id: ARTICLE_ID, content, hasAudio: true });
      expect(article).not.toHaveProperty('audio');
    });

    it('selects the text but never the internal fields or the audio bytes', async () => {
      mockFindUnique.mockResolvedValue(null);

      await findArticleById(ARTICLE_ID);

      const { select } = mockFindUnique.mock.calls[0][0];
      expect(select.content).toBe(true);
      expect(select).not.toHaveProperty('externalId');
      expect(select).not.toHaveProperty('audioSourceUrl');
      expect(select.audio).toEqual({ select: { articleId: true } });
    });

    it('returns null when no article has this id', async () => {
      mockFindUnique.mockResolvedValue(null);

      expect(await findArticleById(ARTICLE_ID)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  describe('findArticleAudio', () => {
    it('returns the bytes, the type and the size of the audio of the given article', async () => {
      const audio = { data: Buffer.from([1, 2, 3]), mimeType: 'audio/mpeg', size: 3 };
      mockAudioFindUnique.mockResolvedValue(audio);

      await expect(findArticleAudio(ARTICLE_ID)).resolves.toEqual(audio);
      expect(mockAudioFindUnique.mock.calls[0][0].where).toEqual({ articleId: ARTICLE_ID });
    });

    it('returns null when there is no audio for this id', async () => {
      mockAudioFindUnique.mockResolvedValue(null);

      expect(await findArticleAudio(ARTICLE_ID)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  describe('findStoredByExternalIds', () => {
    it('looks up only the given posts of the given source', async () => {
      mockFindMany.mockResolvedValue([]);

      await findStoredByExternalIds('holaquepasa', ['1', '2']);

      expect(mockFindMany.mock.calls[0][0].where).toEqual({
        source: 'holaquepasa',
        externalId: { in: ['1', '2'] },
      });
    });

    it('never loads audio bytes, and reports the audio as a boolean', async () => {
      mockFindMany.mockResolvedValue([
        { id: 'a-1', externalId: '1', audio: { articleId: 'a-1' } },
        { id: 'a-2', externalId: '2', audio: null },
      ]);

      const stored = await findStoredByExternalIds('holaquepasa', ['1', '2']);

      // Selecting `data` here would load every MP3 of the batch on each run.
      expect(mockFindMany.mock.calls[0][0].select.audio).toEqual({ select: { articleId: true } });
      expect(stored).toEqual([
        { id: 'a-1', externalId: '1', hasAudio: true },
        { id: 'a-2', externalId: '2', hasAudio: false },
      ]);
    });
  });

  // ─────────────────────────────────────────────
  describe('createArticle', () => {
    it('writes the article and its audio in one nested create, with the size of the audio', async () => {
      mockCreate.mockResolvedValue({});

      await createArticle(newArticle, MP3);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0].data).toEqual({
        ...newArticle,
        // Nested create = same transaction as the article. size = number of bytes.
        audio: { create: { data: MP3.data, mimeType: 'audio/mpeg', size: 4 } },
      });
      // The audio must not ALSO be written through the separate path.
      expect(mockAudioCreate).not.toHaveBeenCalled();
    });

    it('writes no audio at all when there is none', async () => {
      mockCreate.mockResolvedValue({});

      await createArticle(newArticle, null);

      expect(mockCreate.mock.calls[0][0].data).not.toHaveProperty('audio');
    });

    it('turns a P2002 into a UniqueConstraintError', async () => {
      mockCreate.mockRejectedValue(uniqueViolation());

      await expect(createArticle(newArticle, null)).rejects.toBeInstanceOf(UniqueConstraintError);
    });

    it('lets any other database error through as the same object', async () => {
      const dbError = new Error('connection lost');
      mockCreate.mockRejectedValue(dbError);

      await expect(createArticle(newArticle, null)).rejects.toBe(dbError);
    });
  });

  // ─────────────────────────────────────────────
  describe('addArticleAudio', () => {
    it('stores the audio for the given article, with its size', async () => {
      mockAudioCreate.mockResolvedValue({});

      await addArticleAudio('a-1', MP3);

      expect(mockAudioCreate).toHaveBeenCalledWith({
        data: { articleId: 'a-1', data: MP3.data, mimeType: 'audio/mpeg', size: 4 },
      });
    });

    it('turns a P2002 into a UniqueConstraintError', async () => {
      mockAudioCreate.mockRejectedValue(uniqueViolation());

      await expect(addArticleAudio('a-1', MP3)).rejects.toBeInstanceOf(UniqueConstraintError);
    });
  });

  // ─────────────────────────────────────────────
  describe('deleteArticlesOlderThan', () => {
    it('deletes the articles published strictly before the cutoff and returns how many', async () => {
      const cutoff = new Date('2026-09-05T12:00:00.000Z');
      mockDeleteMany.mockResolvedValue({ count: 3 });

      const deleted = await deleteArticlesOlderThan(cutoff);

      expect(mockDeleteMany).toHaveBeenCalledWith({ where: { publishedAt: { lt: cutoff } } });
      expect(deleted).toBe(3);
    });
  });
});
