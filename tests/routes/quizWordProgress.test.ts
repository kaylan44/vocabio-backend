// Tests of GET /quiz-sessions/word-progress.
//
// Kept apart from quizSessions.test.ts so that file stays untouched. Same strategy:
// supertest, auth middleware mocked to inject req.user, service mocked.

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', username: 'Alice', email: 'alice@example.com' };
    next();
  },
}));

// Partial mock: the route validates POST bodies against the real constants.
jest.mock('../../src/services/quizService', () => ({
  ...jest.requireActual('../../src/services/quizService'),
  getWordProgress: jest.fn(),
}));

// The real service module is still loaded by requireActual and imports the Prisma
// singleton: mock it so no database client is created during the tests.
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));

import request from 'supertest';
import express from 'express';
import quizSessionRouter from '../../src/routes/quizSessions';
import { getWordProgress } from '../../src/services/quizService';

const mockGetWordProgress = getWordProgress as jest.Mock;

const app = express();
app.use(express.json());
app.use('/quiz-sessions', quizSessionRouter);

describe('GET /quiz-sessions/word-progress', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the progress of the authenticated user', async () => {
    const progress = [
      {
        wordId: 'n001',
        mode: 'fr-es',
        correctStreak: 2,
        totalSeen: 5,
        totalCorrect: 4,
        lastSeenAt: '2026-10-05T10:00:00.000Z',
      },
    ];
    mockGetWordProgress.mockResolvedValue(progress);

    const res = await request(app).get('/quiz-sessions/word-progress');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(progress);
    expect(mockGetWordProgress).toHaveBeenCalledWith('user-1');
  });

  it('ignores a userId passed in the query string', async () => {
    mockGetWordProgress.mockResolvedValue([]);

    await request(app).get('/quiz-sessions/word-progress?userId=user-2');

    expect(mockGetWordProgress).toHaveBeenCalledWith('user-1');
  });

  it('returns 500 with a generic message when the service fails', async () => {
    mockGetWordProgress.mockRejectedValue(new Error('connection lost'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/quiz-sessions/word-progress');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('connection lost');
  });
});
