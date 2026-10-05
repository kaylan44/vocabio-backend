// Tests of the /articles routes.
//
// Same strategy as quizSessions.test.ts:
// - supertest for the HTTP requests
// - auth middleware mocked (a jest.fn, so one test can make it refuse the request)
// - service mocked: these tests cover the HTTP layer only (validation, status codes,
//   headers, what is passed to the service)

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: jest.fn(),
}));

jest.mock('../../src/services/articleService', () => ({
  listArticles: jest.fn(),
  getArticle: jest.fn(),
  getArticleAudio: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import articleRouter from '../../src/routes/articles';
import { authMiddleware } from '../../src/middleware/auth';
import { getArticle, getArticleAudio, listArticles } from '../../src/services/articleService';

const mockAuth = authMiddleware as jest.Mock;
const mockListArticles = listArticles as jest.Mock;
const mockGetArticle = getArticle as jest.Mock;
const mockGetArticleAudio = getArticleAudio as jest.Mock;

const app = express();
app.use(express.json());
app.use('/articles', articleRouter);

// ─────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────
const ARTICLE_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

const summary = {
  id: ARTICLE_ID,
  source: 'holaquepasa',
  lang: 'es',
  level: 'easy',
  title: 'El gato',
  excerpt: 'El gato vive en una casa.',
  url: 'https://holaquepasa.com/el-gato/',
  imageUrl: null,
  publishedAt: '2026-10-04T12:00:00.000Z',
  audioDurationSec: 65,
  hasAudio: true,
};

const notFound = (message: string) => Object.assign(new Error(message), { statusCode: 404 });

describe('Routes /articles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: a signed-in user.
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'user-1', username: 'Alice', email: 'alice@example.com' };
      next();
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // ─────────────────────────────────────────────
  describe('authentication', () => {
    it.each([['/articles'], [`/articles/${ARTICLE_ID}`], [`/articles/${ARTICLE_ID}/audio`]])(
      'GET %s answers 401 and reaches no service when the middleware refuses',
      async (path) => {
        mockAuth.mockImplementation((_req: any, res: any) => {
          res.status(401).json({ error: 'Token manquant ou mal formaté' });
        });

        const res = await request(app).get(path);

        expect(res.status).toBe(401);
        expect(mockListArticles).not.toHaveBeenCalled();
        expect(mockGetArticle).not.toHaveBeenCalled();
        expect(mockGetArticleAudio).not.toHaveBeenCalled();
      }
    );
  });

  // ─────────────────────────────────────────────
  describe('GET /articles', () => {
    it('returns the articles with the pagination actually applied', async () => {
      mockListArticles.mockResolvedValue([summary]);

      const res = await request(app).get('/articles');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        articles: [summary],
        pagination: { offset: 0, limit: 20, count: 1 },
      });
      expect(mockListArticles).toHaveBeenCalledWith(undefined, 0, 20);
    });

    it('passes the level, offset and limit to the service', async () => {
      mockListArticles.mockResolvedValue([]);

      const res = await request(app).get('/articles?level=intermediate&offset=20&limit=5');

      expect(res.status).toBe(200);
      expect(mockListArticles).toHaveBeenCalledWith('intermediate', 20, 5);
      expect(res.body.pagination).toEqual({ offset: 20, limit: 5, count: 0 });
    });

    it.each([
      ['a limit over the maximum', 'limit=999', 0, 50],
      ['a zero limit', 'limit=0', 0, 20],
      ['a negative limit', 'limit=-5', 0, 1],
      ['an unreadable limit', 'limit=abc', 0, 20],
      ['a negative offset', 'offset=-3', 0, 20],
      ['a huge offset', 'offset=99999999', 10_000, 20],
      ['a repeated parameter', 'limit=5&limit=6', 0, 20],
    ])('bounds %s', async (_label, query, expectedOffset, expectedLimit) => {
      mockListArticles.mockResolvedValue([]);

      const res = await request(app).get(`/articles?${query}`);

      expect(res.status).toBe(200);
      expect(mockListArticles).toHaveBeenCalledWith(undefined, expectedOffset, expectedLimit);
    });

    it.each([['hard'], ['EASY'], [''], ['easy&level=intermediate']])(
      'answers 400 for the unknown level %p instead of returning every article',
      async (level) => {
        const res = await request(app).get(`/articles?level=${level}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('easy, intermediate');
        expect(mockListArticles).not.toHaveBeenCalled();
      }
    );

    it('answers 500 with a generic message when the service fails', async () => {
      mockListArticles.mockRejectedValue(new Error('connection to database lost at 10.0.0.5'));

      const res = await request(app).get('/articles');

      expect(res.status).toBe(500);
      // The internal detail must not reach the client.
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    });
  });

  // ─────────────────────────────────────────────
  describe('GET /articles/:id', () => {
    it('returns the article', async () => {
      const article = {
        ...summary,
        content: [{ type: 'paragraph', segments: [{ text: 'El gato vive en ' }, { text: 'una casa', gloss: 'a house' }] }],
      };
      mockGetArticle.mockResolvedValue(article);

      const res = await request(app).get(`/articles/${ARTICLE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(article);
      expect(mockGetArticle).toHaveBeenCalledWith(ARTICLE_ID);
    });

    it.each([['42'], ['not-a-uuid'], [`${ARTICLE_ID}x`]])(
      'answers 400 for the malformed id %p without calling the service',
      async (id) => {
        const res = await request(app).get(`/articles/${id}`);

        expect(res.status).toBe(400);
        expect(mockGetArticle).not.toHaveBeenCalled();
      }
    );

    it('answers 404 when the service does not find the article', async () => {
      mockGetArticle.mockRejectedValue(notFound('Article not found'));

      const res = await request(app).get(`/articles/${ARTICLE_ID}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Article not found' });
    });
  });

  // ─────────────────────────────────────────────
  describe('GET /articles/:id/audio', () => {
    // Bytes chosen to include values that break if the body were treated as text.
    const BYTES = Buffer.from([0xff, 0xf3, 0x84, 0x00, 0x0a, 0x80, 0xfe]);

    it('returns exactly the stored bytes with the audio headers', async () => {
      mockGetArticleAudio.mockResolvedValue({ data: BYTES, mimeType: 'audio/mpeg', size: BYTES.length });

      const res = await request(app)
        .get(`/articles/${ARTICLE_ID}/audio`)
        // supertest only buffers known text/JSON types: collect the binary ourselves.
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, BYTES)).toBe(0);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['content-length']).toBe(String(BYTES.length));
      // private: the response depends on the JWT, a shared cache must not keep it.
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(mockGetArticleAudio).toHaveBeenCalledWith(ARTICLE_ID);
    });

    it('answers 400 for a malformed id without calling the service', async () => {
      const res = await request(app).get('/articles/42/audio');

      expect(res.status).toBe(400);
      expect(mockGetArticleAudio).not.toHaveBeenCalled();
    });

    it('answers 404 as JSON when the article has no audio', async () => {
      mockGetArticleAudio.mockRejectedValue(notFound('Audio not found'));

      const res = await request(app).get(`/articles/${ARTICLE_ID}/audio`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Audio not found' });
      // The audio headers must not have been set on an error response.
      expect(res.headers['content-type']).toContain('application/json');
    });
  });
});
