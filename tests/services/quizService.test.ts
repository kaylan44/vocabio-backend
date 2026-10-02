// Unit tests of the quiz service.
//
// Prisma is mocked: these tests check the logic of the service (what it computes,
// what it refuses, how it filters), NOT that the queries are valid SQL. There is no
// test against a real database in this project yet.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    quizSession: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      groupBy: jest.fn(),
    },
    quizAnswer: {
      groupBy: jest.fn(),
    },
  },
}));

// '@prisma/client' itself is NOT mocked: we need the real error class to build a
// genuine P2002 error, the same one the service detects with `instanceof`.
import { Prisma } from '@prisma/client';
import {
  createQuizSession,
  getQuizStats,
  MOST_MISSED_LIMIT,
  QuizAnswerInput,
} from '../../src/services/quizService';
import { prisma } from '../../src/lib/prisma';

const mockFindUnique = prisma.quizSession.findUnique as jest.Mock;
const mockFindFirst = prisma.quizSession.findFirst as jest.Mock;
const mockCreate = prisma.quizSession.create as jest.Mock;
const mockSessionGroupBy = prisma.quizSession.groupBy as jest.Mock;
const mockAnswerGroupBy = prisma.quizAnswer.groupBy as jest.Mock;

const SESSION_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

const answers: QuizAnswerInput[] = [
  { wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true },
  { wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false },
  { wordId: 'n003', category: 'noun', level: 'A1', isCorrect: true },
];

// A row as Prisma returns it with SESSION_SELECT (userId included).
const storedSession = (userId: string) => ({
  id: SESSION_ID,
  userId,
  mode: 'fr-es',
  score: 2,
  total: 3,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
});

// What the service is expected to hand back: the same row without userId.
const publicSession = {
  id: SESSION_ID,
  mode: 'fr-es',
  score: 2,
  total: 3,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe('quizService', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): it also drops queued mockResolvedValueOnce
    // values, so a test can never inherit a leftover answer from the previous one.
    jest.resetAllMocks();
  });

  // ─────────────────────────────────────────────
  describe('createQuizSession', () => {
    it('stores the session with score and total computed from the answers', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      const { data } = mockCreate.mock.calls[0][0];
      expect(data).toMatchObject({
        id: SESSION_ID,
        userId: 'user-1',
        mode: 'fr-es',
        score: 2, // two answers out of three are correct
        total: 3,
      });
      expect(result).toEqual({ session: publicSession, created: true });
    });

    it('stores one answer per question with positions 0..n-1 in the given order', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      const { data } = mockCreate.mock.calls[0][0];
      expect(data.answers.create).toEqual([
        { position: 0, wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true },
        { position: 1, wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false },
        { position: 2, wordId: 'n003', category: 'noun', level: 'A1', isCorrect: true },
      ]);
    });

    it('does not expose userId in the returned session', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      const { session } = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(session).not.toHaveProperty('userId');
    });

    it('returns the existing session without creating anything on a replay by the owner', async () => {
      mockFindUnique.mockResolvedValue(storedSession('user-1'));

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result).toEqual({ session: publicSession, created: false });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects with 409 when the id belongs to another user, without creating', async () => {
      mockFindUnique.mockResolvedValue(storedSession('user-2'));

      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects with 429 when the user created a session less than 10 seconds ago', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue({ createdAt: secondsAgo(5) });

      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('looks for the latest session of the given user only when rate limiting', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      // A wrong `where` here would rate limit a user because of someone else's quiz.
      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('creates the session when the previous one is older than 10 seconds', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue({ createdAt: secondsAgo(11) });
      mockCreate.mockResolvedValue(storedSession('user-1'));

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result.created).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('treats a replay as a success even inside the rate limit window', async () => {
      // The session being replayed is itself the "latest session", created 2 s ago.
      // The replay check runs first, so the rate limit must not even be consulted.
      mockFindUnique.mockResolvedValue(storedSession('user-1'));
      mockFindFirst.mockResolvedValue({ createdAt: secondsAgo(2) });

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result.created).toBe(false);
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('treats a concurrent duplicate seen by the rate limit as a replay, not a 429', async () => {
      // Two identical requests at the same instant. Ours saw nothing at the first
      // lookup, then the other request stored the session: the rate limit query now
      // returns that very session, created a moment ago.
      mockFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedSession('user-1'));
      mockFindFirst.mockResolvedValue({ id: SESSION_ID, createdAt: secondsAgo(0) });

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result).toEqual({ session: publicSession, created: false });
      // The quiz is already stored: it must not be written a second time.
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('still rejects with 429 when the recent session is a different quiz', async () => {
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue({ id: 'another-session-id', createdAt: secondsAgo(0) });

      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('treats a P2002 race as a replay when the stored session belongs to the caller', async () => {
      // First lookup: nothing yet. The create then loses the race. Second lookup
      // (after the error): the session inserted by the concurrent request.
      mockFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedSession('user-1'));
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockRejectedValue(uniqueViolation());

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result).toEqual({ session: publicSession, created: false });
    });

    it('rejects with 409 on a P2002 race when the stored session belongs to another user', async () => {
      mockFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedSession('user-2'));
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockRejectedValue(uniqueViolation());

      // The other user's session must not leak through the race path.
      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rethrows any other database error untouched', async () => {
      const dbError = new Error('connection lost');
      mockFindUnique.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockRejectedValue(dbError);

      await expect(createQuizSession('user-1', SESSION_ID, 'fr-es', answers)).rejects.toBe(
        dbError
      );
    });
  });

  // ─────────────────────────────────────────────
  describe('getQuizStats', () => {
    // quizAnswer.groupBy is called three times (category, level, missed words).
    // We answer according to the `by` argument rather than the call order, so the
    // test does not depend on the order of the queries inside Promise.all.
    const mockAnswerRows = (rows: {
      category?: unknown[];
      level?: unknown[];
      wordId?: unknown[];
    }) => {
      mockAnswerGroupBy.mockImplementation(async (args: { by: string[] }) => {
        const key = args.by[0] as 'category' | 'level' | 'wordId';
        return rows[key] ?? [];
      });
    };

    it('returns zeros, null accuracy and empty lists when the user has no session', async () => {
      mockSessionGroupBy.mockResolvedValue([]);
      mockAnswerRows({});

      const stats = await getQuizStats('user-1');

      expect(stats).toEqual({
        totalSessions: 0,
        totalAnswers: 0,
        totalCorrect: 0,
        accuracy: null, // not 0: there is nothing to compute a ratio from
        lastSessionAt: null,
        byMode: [],
        byCategory: [],
        byLevel: [],
        mostMissedWords: [],
      });
    });

    it('computes totals, per-mode figures and the last session date', async () => {
      mockSessionGroupBy.mockResolvedValue([
        // Deliberately returned in the "wrong" order: the service sorts by QUIZ_MODES.
        {
          mode: 'es-fr',
          _count: { _all: 1 },
          _sum: { score: 5, total: 10 },
          _max: { createdAt: new Date('2026-09-20T08:00:00.000Z') },
        },
        {
          mode: 'fr-es',
          _count: { _all: 2 },
          _sum: { score: 15, total: 20 },
          _max: { createdAt: new Date('2026-10-01T08:00:00.000Z') },
        },
      ]);
      mockAnswerRows({});

      const stats = await getQuizStats('user-1');

      expect(stats.totalSessions).toBe(3);
      expect(stats.totalAnswers).toBe(30);
      expect(stats.totalCorrect).toBe(20);
      expect(stats.accuracy).toBe(0.667); // 20 / 30 rounded to 3 decimals
      expect(stats.lastSessionAt).toEqual(new Date('2026-10-01T08:00:00.000Z'));
      expect(stats.byMode).toEqual([
        { mode: 'fr-es', sessions: 2, answers: 20, correct: 15, accuracy: 0.75 },
        { mode: 'es-fr', sessions: 1, answers: 10, correct: 5, accuracy: 0.5 },
      ]);
    });

    it('merges correct and wrong rows into one entry per category and per level', async () => {
      mockSessionGroupBy.mockResolvedValue([]);
      mockAnswerRows({
        category: [
          { category: 'verb', isCorrect: false, _count: { _all: 4 } },
          { category: 'noun', isCorrect: true, _count: { _all: 33 } },
          { category: 'noun', isCorrect: false, _count: { _all: 7 } },
        ],
        level: [
          { level: 'A2', isCorrect: true, _count: { _all: 3 } },
          { level: 'A1', isCorrect: true, _count: { _all: 9 } },
          { level: 'A1', isCorrect: false, _count: { _all: 1 } },
        ],
      });

      const stats = await getQuizStats('user-1');

      expect(stats.byCategory).toEqual([
        { category: 'noun', answers: 40, correct: 33, accuracy: 0.825 },
        // Only wrong answers for verbs: correct is 0 and accuracy is 0, not null.
        { category: 'verb', answers: 4, correct: 0, accuracy: 0 },
      ]);
      expect(stats.byLevel).toEqual([
        { level: 'A1', answers: 10, correct: 9, accuracy: 0.9 },
        { level: 'A2', answers: 3, correct: 3, accuracy: 1 },
      ]);
    });

    it('returns the most missed words with their wrong count', async () => {
      mockSessionGroupBy.mockResolvedValue([]);
      mockAnswerRows({
        wordId: [
          { wordId: 'v042', _count: { wordId: 4 } },
          { wordId: 'n001', _count: { wordId: 2 } },
        ],
      });

      const stats = await getQuizStats('user-1');

      expect(stats.mostMissedWords).toEqual([
        { wordId: 'v042', wrong: 4 },
        { wordId: 'n001', wrong: 2 },
      ]);
    });

    it('filters every query by the given user', async () => {
      mockSessionGroupBy.mockResolvedValue([]);
      mockAnswerRows({});

      await getQuizStats('user-1');

      // Sessions are filtered directly, answers through their session. A missing
      // filter here would mix the statistics of all users.
      expect(mockSessionGroupBy).toHaveBeenCalledTimes(1);
      expect(mockSessionGroupBy.mock.calls[0][0].where).toEqual({ userId: 'user-1' });

      expect(mockAnswerGroupBy).toHaveBeenCalledTimes(3);
      for (const [args] of mockAnswerGroupBy.mock.calls) {
        expect(args.where).toMatchObject({ session: { userId: 'user-1' } });
      }
    });

    it('asks for wrong answers only, ordered by count then wordId, limited', async () => {
      mockSessionGroupBy.mockResolvedValue([]);
      mockAnswerRows({});

      await getQuizStats('user-1');

      const missedCall = mockAnswerGroupBy.mock.calls
        .map(([args]) => args)
        .find((args) => args.by[0] === 'wordId');

      expect(missedCall.where).toEqual({ session: { userId: 'user-1' }, isCorrect: false });
      // The secondary sort on wordId keeps ties in a stable order between calls.
      expect(missedCall.orderBy).toEqual([{ _count: { wordId: 'desc' } }, { wordId: 'asc' }]);
      expect(missedCall.take).toBe(MOST_MISSED_LIMIT);
    });
  });
});
