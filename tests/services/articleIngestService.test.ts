// Unit tests of the article ingestion service.
//
// Mocked: Prisma (no database) and the source client (no network). The parser is
// REAL: it is pure, and going through it checks that the ingestion and the parser
// agree on the shape of an article.
//
// As everywhere in this project, these tests check the logic of the service (what it
// stores, what it skips, what it survives), not that the queries are valid SQL.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    article: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    articleAudio: {
      create: jest.fn(),
    },
  },
}));

// Partial mock: the two network functions are replaced, isSourceUrl and the category
// ids stay real because the parser relies on them.
jest.mock('../../src/lib/holaQuePasa', () => ({
  ...jest.requireActual('../../src/lib/holaQuePasa'),
  fetchLatestPosts: jest.fn(),
  downloadAudio: jest.fn(),
}));

import { Prisma } from '@prisma/client';
import { prisma } from '../../src/lib/prisma';
import { downloadAudio, fetchLatestPosts } from '../../src/lib/holaQuePasa';
import {
  ARTICLE_LANG,
  ARTICLE_SOURCE,
  INGEST_BATCH_SIZE,
  RETENTION_DAYS,
  runIngestion,
} from '../../src/services/articleIngestService';

const mockFetchLatestPosts = fetchLatestPosts as jest.Mock;
const mockDownloadAudio = downloadAudio as jest.Mock;
const mockFindMany = prisma.article.findMany as jest.Mock;
const mockCreate = prisma.article.create as jest.Mock;
const mockDeleteMany = prisma.article.deleteMany as jest.Mock;
const mockAudioCreate = prisma.articleAudio.create as jest.Mock;

// ─────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────
const NOW = new Date('2026-10-05T12:00:00.000Z');

const audioUrl = (id: number) => `https://holaquepasa.com/wp-content/uploads/2026/09/audio-${id}.mp3`;

// A minimal post the real parser accepts. `withAudio: false` gives an article with
// no audio block at all.
const makePost = (id: number, dateGmt = '2026-10-04T12:00:00', withAudio = true) => ({
  id,
  date_gmt: dateGmt,
  link: `https://holaquepasa.com/articulo-${id}/`,
  title: { rendered: `Artículo ${id}` },
  categories: [331, 23],
  content: {
    rendered:
      (withAudio
        ? `<div itemscope><meta itemprop="duration" content="PT1M5S" /><meta itemprop="contentUrl" content="${audioUrl(id)}" /></div>`
        : '') + `<p>Texto del artículo ${id}.</p>`,
  },
});

const MP3 = { data: Buffer.from([0xff, 0xf3, 0x84, 0x01]), mimeType: 'audio/mpeg' };

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('articleIngestService.runIngestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The service logs what it survives; keep the test output readable.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Defaults: nothing stored yet, every write succeeds, nothing to purge.
    mockFindMany.mockResolvedValue([]);
    mockCreate.mockResolvedValue({});
    mockAudioCreate.mockResolvedValue({});
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockDownloadAudio.mockResolvedValue(MP3);
  });

  afterEach(() => jest.restoreAllMocks());

  it('asks the source for one batch and looks up only that batch in the database', async () => {
    mockFetchLatestPosts.mockResolvedValue([makePost(1), makePost(2)]);

    await runIngestion(NOW);

    expect(mockFetchLatestPosts).toHaveBeenCalledWith(INGEST_BATCH_SIZE);
    expect(mockFindMany.mock.calls[0][0].where).toEqual({
      source: ARTICLE_SOURCE,
      externalId: { in: ['1', '2'] },
    });
  });

  it('never loads audio bytes when checking what is already stored', async () => {
    mockFetchLatestPosts.mockResolvedValue([makePost(1)]);

    await runIngestion(NOW);

    // `audio` may only select its key: selecting `data` here would load every MP3
    // of the batch into memory on each run.
    expect(mockFindMany.mock.calls[0][0].select.audio).toEqual({ select: { articleId: true } });
  });

  // ─────────────────────────────────────────────
  describe('a new article', () => {
    it('is stored with its text, its metadata and its audio in one write', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1)]);

      const report = await runIngestion(NOW);

      expect(mockDownloadAudio).toHaveBeenCalledWith(audioUrl(1));
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0].data).toEqual({
        source: ARTICLE_SOURCE,
        externalId: '1',
        lang: ARTICLE_LANG,
        level: 'easy',
        title: 'Artículo 1',
        excerpt: 'Texto del artículo 1.',
        content: [{ type: 'paragraph', segments: [{ text: 'Texto del artículo 1.' }] }],
        url: 'https://holaquepasa.com/articulo-1/',
        imageUrl: null,
        audioSourceUrl: audioUrl(1),
        audioDurationSec: 65,
        publishedAt: new Date('2026-10-04T12:00:00.000Z'),
        // Nested create = same transaction as the article.
        audio: { create: { data: MP3.data, mimeType: 'audio/mpeg', size: 4 } },
      });
      // The audio must not ALSO be written through the separate path.
      expect(mockAudioCreate).not.toHaveBeenCalled();
      expect(report).toEqual({ created: 1, audioAdded: 0, skipped: 0, failed: 0, purged: 0 });
    });

    it('is stored WITHOUT audio when the download fails, and still counts as created', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1)]);
      mockDownloadAudio.mockRejectedValue(new Error('Audio download answered 503'));

      const report = await runIngestion(NOW);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const data = mockCreate.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('audio');
      // The URL is kept: it is what lets a later run retry the download.
      expect(data.audioSourceUrl).toBe(audioUrl(1));
      expect(report.created).toBe(1);
      expect(report.failed).toBe(0);
    });

    it('is stored without audio and without any download when the post has none', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1, '2026-10-04T12:00:00', false)]);

      await runIngestion(NOW);

      expect(mockDownloadAudio).not.toHaveBeenCalled();
      const data = mockCreate.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('audio');
      expect(data.audioSourceUrl).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  describe('an article already stored', () => {
    it('is skipped with no download and no write when it has its audio', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1)]);
      mockFindMany.mockResolvedValue([{ id: 'a-1', externalId: '1', audio: { articleId: 'a-1' } }]);

      const report = await runIngestion(NOW);

      expect(mockDownloadAudio).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAudioCreate).not.toHaveBeenCalled();
      expect(report).toEqual({ created: 0, audioAdded: 0, skipped: 1, failed: 0, purged: 0 });
    });

    it('gets its audio on a later run when it was stored without it', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1)]);
      mockFindMany.mockResolvedValue([{ id: 'a-1', externalId: '1', audio: null }]);

      const report = await runIngestion(NOW);

      expect(mockDownloadAudio).toHaveBeenCalledWith(audioUrl(1));
      expect(mockAudioCreate).toHaveBeenCalledWith({
        data: { articleId: 'a-1', data: MP3.data, mimeType: 'audio/mpeg', size: 4 },
      });
      // The article itself is not created a second time.
      expect(mockCreate).not.toHaveBeenCalled();
      expect(report).toEqual({ created: 0, audioAdded: 1, skipped: 0, failed: 0, purged: 0 });
    });

    it('stays without audio, counted as skipped, when the retry fails again', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1)]);
      mockFindMany.mockResolvedValue([{ id: 'a-1', externalId: '1', audio: null }]);
      mockDownloadAudio.mockRejectedValue(new Error('timeout'));

      const report = await runIngestion(NOW);

      expect(mockAudioCreate).not.toHaveBeenCalled();
      expect(report).toEqual({ created: 0, audioAdded: 0, skipped: 1, failed: 0, purged: 0 });
    });
  });

  // ─────────────────────────────────────────────
  describe('resilience', () => {
    it('counts an unusable post as failed and still stores the others', async () => {
      mockFetchLatestPosts.mockResolvedValue([{ id: 'broken' }, makePost(2), null]);

      const report = await runIngestion(NOW);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0].data.externalId).toBe('2');
      expect(report.failed).toBe(2);
      expect(report.created).toBe(1);
    });

    it('keeps going when storing one article fails', async () => {
      mockFetchLatestPosts.mockResolvedValue([makePost(1), makePost(2)]);
      mockCreate.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({});

      const report = await runIngestion(NOW);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(report).toEqual({ created: 1, audioAdded: 0, skipped: 0, failed: 1, purged: 0 });
    });

    it('treats a unique violation as "already stored", not as a failure', async () => {
      // Another run stored the article between our read and our write.
      mockFetchLatestPosts.mockResolvedValue([makePost(1)]);
      mockCreate.mockRejectedValue(uniqueViolation());

      const report = await runIngestion(NOW);

      expect(report).toEqual({ created: 0, audioAdded: 0, skipped: 1, failed: 0, purged: 0 });
    });

    it('downloads one audio at a time', async () => {
      // If the service used Promise.all, the second download would start before the
      // first create: this order would not hold.
      const order: string[] = [];
      mockFetchLatestPosts.mockResolvedValue([makePost(1), makePost(2)]);
      mockDownloadAudio.mockImplementation(async (url: string) => {
        order.push(`download ${url.slice(-11)}`);
        return MP3;
      });
      mockCreate.mockImplementation(async ({ data }: { data: { externalId: string } }) => {
        order.push(`create ${data.externalId}`);
        return {};
      });

      await runIngestion(NOW);

      expect(order).toEqual(['download audio-1.mp3', 'create 1', 'download audio-2.mp3', 'create 2']);
    });

    it('throws and purges NOTHING when the source cannot be reached', async () => {
      mockFetchLatestPosts.mockRejectedValue(new Error('Article source answered 503'));

      await expect(runIngestion(NOW)).rejects.toThrow('503');
      // A source that is down must not slowly empty the app.
      expect(mockDeleteMany).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  describe('retention', () => {
    it(`deletes the articles published more than ${RETENTION_DAYS} days ago`, async () => {
      mockFetchLatestPosts.mockResolvedValue([]);
      mockDeleteMany.mockResolvedValue({ count: 3 });

      const report = await runIngestion(NOW);

      // 30 days before 2026-10-05T12:00Z.
      expect(mockDeleteMany).toHaveBeenCalledWith({
        where: { publishedAt: { lt: new Date('2026-09-05T12:00:00.000Z') } },
      });
      expect(report.purged).toBe(3);
    });

    it('does not download or store an article that is already past the retention', async () => {
      // Otherwise it would be created, purged, then downloaded again on every run.
      mockFetchLatestPosts.mockResolvedValue([makePost(1, '2026-08-01T12:00:00'), makePost(2)]);

      const report = await runIngestion(NOW);

      expect(mockDownloadAudio).toHaveBeenCalledTimes(1);
      expect(mockDownloadAudio).toHaveBeenCalledWith(audioUrl(2));
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(report).toEqual({ created: 1, audioAdded: 0, skipped: 1, failed: 0, purged: 0 });
    });
  });
});
