// Tests of the /quiz-sessions routes.
//
// Same strategy as messages.test.ts:
// - supertest for the HTTP requests
// - auth middleware mocked to inject req.user
// - service mocked: these tests cover the HTTP layer only (validation, status codes)

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', username: 'Alice', email: 'alice@example.com' };
    next();
  },
}));

// Partial mock: the two functions are replaced, but the constants (QUIZ_MODES,
// MAX_ANSWERS_PER_SESSION...) keep their real values. The route validates against
// them, so mocking them away would make the validation tests meaningless.
jest.mock('../../src/services/quizService', () => ({
  ...jest.requireActual('../../src/services/quizService'),
  createQuizSession: jest.fn(),
  getQuizStats: jest.fn(),
}));

// The real service module is still loaded by requireActual and imports the Prisma
// singleton: mock it so no database client is created during the tests.
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));

import request from 'supertest';
import express from 'express';
import quizSessionRouter from '../../src/routes/quizSessions';
import {
  createQuizSession,
  getQuizStats,
  MAX_ANSWERS_PER_SESSION,
} from '../../src/services/quizService';

const mockCreateQuizSession = createQuizSession as jest.Mock;
const mockGetQuizStats = getQuizStats as jest.Mock;

const app = express();
app.use(express.json());
app.use('/quiz-sessions', quizSessionRouter);

// ─────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────
const SESSION_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

const validAnswer = { wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true };

const validBody = {
  id: SESSION_ID,
  mode: 'fr-es',
  answers: [validAnswer, { wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false }],
};

const fakeSession = {
  id: SESSION_ID,
  mode: 'fr-es',
  score: 1,
  total: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
};

describe('Routes /quiz-sessions', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('POST /quiz-sessions', () => {
    it('returns 201 and the session when it is created', async () => {
      mockCreateQuizSession.mockResolvedValue({ session: fakeSession, created: true });

      const res = await request(app).post('/quiz-sessions').send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(fakeSession);
    });

    it('returns 200 on an idempotent replay', async () => {
      mockCreateQuizSession.mockResolvedValue({ session: fakeSession, created: false });

      const res = await request(app).post('/quiz-sessions').send(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(fakeSession);
    });

    it('uses the user id from the JWT, ignoring a userId sent in the body', async () => {
      mockCreateQuizSession.mockResolvedValue({ session: fakeSession, created: true });

      await request(app)
        .post('/quiz-sessions')
        .send({ ...validBody, userId: 'user-2' });

      expect(mockCreateQuizSession).toHaveBeenCalledWith(
        'user-1',
        SESSION_ID,
        'fr-es',
        validBody.answers
      );
    });

    it('drops unknown fields of an answer before calling the service', async () => {
      mockCreateQuizSession.mockResolvedValue({ session: fakeSession, created: true });

      await request(app)
        .post('/quiz-sessions')
        .send({ ...validBody, answers: [{ ...validAnswer, position: 99, sessionId: 'x' }] });

      expect(mockCreateQuizSession.mock.calls[0][3]).toEqual([validAnswer]);
    });

    it('lowercases the id so the same UUID always maps to the same session', async () => {
      mockCreateQuizSession.mockResolvedValue({ session: fakeSession, created: true });

      await request(app)
        .post('/quiz-sessions')
        .send({ ...validBody, id: SESSION_ID.toUpperCase() });

      expect(mockCreateQuizSession.mock.calls[0][1]).toBe(SESSION_ID);
    });

    it('accepts the same wordId twice in one session', async () => {
      mockCreateQuizSession.mockResolvedValue({ session: fakeSession, created: true });

      const res = await request(app)
        .post('/quiz-sessions')
        .send({ ...validBody, answers: [validAnswer, validAnswer] });

      expect(res.status).toBe(201);
    });

    // One case per validation rule. Each must answer 400 with an error message and
    // must NOT reach the service.
    const tooManyAnswers = Array.from({ length: MAX_ANSWERS_PER_SESSION + 1 }, () => validAnswer);

    it.each<[string, unknown]>([
      ['id is missing', { ...validBody, id: undefined }],
      ['id is not a UUID', { ...validBody, id: 'not-a-uuid' }],
      ['id is not a string', { ...validBody, id: 12345 }],
      ['mode is unknown', { ...validBody, mode: 'fr-de' }],
      ['mode is missing', { ...validBody, mode: undefined }],
      ['answers is missing', { ...validBody, answers: undefined }],
      ['answers is not an array', { ...validBody, answers: 'n001' }],
      ['answers is empty', { ...validBody, answers: [] }],
      ['answers has too many items', { ...validBody, answers: tooManyAnswers }],
      // The two cases below would throw a TypeError (and hang the request) if the
      // route read answer.wordId without checking the type first.
      ['an answer is null', { ...validBody, answers: [null] }],
      ['an answer is not an object', { ...validBody, answers: ['n001'] }],
      ['wordId is empty', { ...validBody, answers: [{ ...validAnswer, wordId: '' }] }],
      ['wordId is too long', { ...validBody, answers: [{ ...validAnswer, wordId: 'n'.repeat(21) }] }],
      ['wordId is not a string', { ...validBody, answers: [{ ...validAnswer, wordId: 1 }] }],
      ['category is unknown', { ...validBody, answers: [{ ...validAnswer, category: 'article' }] }],
      ['level is unknown', { ...validBody, answers: [{ ...validAnswer, level: 'C2' }] }],
      ['isCorrect is a string', { ...validBody, answers: [{ ...validAnswer, isCorrect: 'true' }] }],
      ['isCorrect is missing', { ...validBody, answers: [{ ...validAnswer, isCorrect: undefined }] }],
      ['the body is an array', [validBody]],
    ])('returns 400 when %s', async (_label, body) => {
      const res = await request(app)
        .post('/quiz-sessions')
        .send(body as object);

      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
      expect(mockCreateQuizSession).not.toHaveBeenCalled();
    });

    it('returns 409 when the id belongs to another user', async () => {
      const err = new Error('This quiz session id is already in use') as any;
      err.statusCode = 409;
      mockCreateQuizSession.mockRejectedValue(err);

      const res = await request(app).post('/quiz-sessions').send(validBody);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'This quiz session id is already in use' });
    });

    it('returns 429 when the rate limit is hit', async () => {
      const err = new Error('Too many quiz sessions') as any;
      err.statusCode = 429;
      mockCreateQuizSession.mockRejectedValue(err);

      const res = await request(app).post('/quiz-sessions').send(validBody);

      expect(res.status).toBe(429);
    });

    it('returns 500 with a generic message when the service fails unexpectedly', async () => {
      mockCreateQuizSession.mockRejectedValue(new Error('password authentication failed for db'));
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).post('/quiz-sessions').send(validBody);

      expect(res.status).toBe(500);
      // The internal message must never reach the client.
      expect(JSON.stringify(res.body)).not.toContain('password');
    });
  });

  // ─────────────────────────────────────────────
  describe('GET /quiz-sessions/stats', () => {
    it('returns 200 with the statistics of the authenticated user', async () => {
      const stats = { totalSessions: 3, accuracy: 0.667, mostMissedWords: [] };
      mockGetQuizStats.mockResolvedValue(stats);

      const res = await request(app).get('/quiz-sessions/stats');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(stats);
      expect(mockGetQuizStats).toHaveBeenCalledWith('user-1');
    });

    it('returns 500 with a generic message when the service fails', async () => {
      mockGetQuizStats.mockRejectedValue(new Error('connection lost'));
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).get('/quiz-sessions/stats');

      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('connection lost');
    });
  });
});
