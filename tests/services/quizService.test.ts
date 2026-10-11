// Unit tests of the quiz service.
//
// The repository is mocked: these tests check the logic of the service (what it
// computes, what it refuses, who it reads for). The shape of the queries, and that
// each one is filtered by user, is checked in tests/repositories/quizRepository.test.ts.
// Nothing here or there proves the queries are valid SQL: there is no test against a
// real database in this project yet.

jest.mock('../../src/repositories/quizRepository', () => ({
  findSessionById: jest.fn(),
  findLatestSessionOf: jest.fn(),
  createSessionWithAnswers: jest.fn(),
  sumSessionsByMode: jest.fn(),
  countAnswersByCategory: jest.fn(),
  countAnswersByLevel: jest.fn(),
  findMostMissedWords: jest.fn(),
}));

// src/repositories/errors is NOT mocked: we need the real class, the same one the
// service detects with `instanceof`.
import { UniqueConstraintError } from '../../src/repositories/errors';
import {
  createQuizSession,
  getQuizStats,
  MOST_MISSED_LIMIT,
} from '../../src/services/quizService';
import { QuizAnswerInput } from '../../src/types/quiz';
import * as quizRepository from '../../src/repositories/quizRepository';

const mockFindSession = quizRepository.findSessionById as jest.Mock;
const mockFindLatest = quizRepository.findLatestSessionOf as jest.Mock;
const mockCreate = quizRepository.createSessionWithAnswers as jest.Mock;
const mockSumByMode = quizRepository.sumSessionsByMode as jest.Mock;
const mockCountByCategory = quizRepository.countAnswersByCategory as jest.Mock;
const mockCountByLevel = quizRepository.countAnswersByLevel as jest.Mock;
const mockMissedWords = quizRepository.findMostMissedWords as jest.Mock;

const SESSION_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

const answers: QuizAnswerInput[] = [
  { wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true },
  { wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false },
  { wordId: 'n003', category: 'noun', level: 'A1', isCorrect: true },
];

// A session as the repository returns it (userId included).
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

// What the repository throws when the insert loses on the primary key (it translates
// Prisma's P2002, see quizRepository.test.ts).
const uniqueViolation = () => new UniqueConstraintError();

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
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      const session = mockCreate.mock.calls[0][0];
      expect(session).toMatchObject({
        id: SESSION_ID,
        userId: 'user-1',
        mode: 'fr-es',
        score: 2, // two answers out of three are correct
        total: 3,
      });
      expect(result).toEqual({ session: publicSession, created: true });
    });

    it('hands every answer to the repository, in the order the questions were asked', async () => {
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      // The repository turns this order into positions 0..n-1 (quizRepository.test.ts):
      // a reordered or truncated list here would store the wrong quiz.
      expect(mockCreate.mock.calls[0][0].answers).toEqual([
        { wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true },
        { wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false },
        { wordId: 'n003', category: 'noun', level: 'A1', isCorrect: true },
      ]);
    });

    it('does not expose userId in the returned session', async () => {
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      const { session } = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(session).not.toHaveProperty('userId');
    });

    it('returns the existing session without creating anything on a replay by the owner', async () => {
      mockFindSession.mockResolvedValue(storedSession('user-1'));

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result).toEqual({ session: publicSession, created: false });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects with 409 when the id belongs to another user, without creating', async () => {
      mockFindSession.mockResolvedValue(storedSession('user-2'));

      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects with 429 when the user created a session less than 10 seconds ago', async () => {
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue({ createdAt: secondsAgo(5) });

      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('looks for the latest session of the given user only when rate limiting', async () => {
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockResolvedValue(storedSession('user-1'));

      await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      // Another user here would rate limit someone because of someone else's quiz.
      expect(mockFindLatest).toHaveBeenCalledWith('user-1');
    });

    it('creates the session when the previous one is older than 10 seconds', async () => {
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue({ createdAt: secondsAgo(11) });
      mockCreate.mockResolvedValue(storedSession('user-1'));

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result.created).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('treats a replay as a success even inside the rate limit window', async () => {
      // The session being replayed is itself the "latest session", created 2 s ago.
      // The replay check runs first, so the rate limit must not even be consulted.
      mockFindSession.mockResolvedValue(storedSession('user-1'));
      mockFindLatest.mockResolvedValue({ createdAt: secondsAgo(2) });

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result.created).toBe(false);
      expect(mockFindLatest).not.toHaveBeenCalled();
    });

    it('treats a concurrent duplicate seen by the rate limit as a replay, not a 429', async () => {
      // Two identical requests at the same instant. Ours saw nothing at the first
      // lookup, then the other request stored the session: the rate limit query now
      // returns that very session, created a moment ago.
      mockFindSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedSession('user-1'));
      mockFindLatest.mockResolvedValue({ id: SESSION_ID, createdAt: secondsAgo(0) });

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result).toEqual({ session: publicSession, created: false });
      // The quiz is already stored: it must not be written a second time.
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('still rejects with 429 when the recent session is a different quiz', async () => {
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue({ id: 'another-session-id', createdAt: secondsAgo(0) });

      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('treats a unique violation race as a replay when the stored session belongs to the caller', async () => {
      // First lookup: nothing yet. The create then loses the race. Second lookup
      // (after the error): the session inserted by the concurrent request.
      mockFindSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedSession('user-1'));
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockRejectedValue(uniqueViolation());

      const result = await createQuizSession('user-1', SESSION_ID, 'fr-es', answers);

      expect(result).toEqual({ session: publicSession, created: false });
    });

    it('rejects with 409 on a unique violation race when the stored session belongs to another user', async () => {
      mockFindSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedSession('user-2'));
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockRejectedValue(uniqueViolation());

      // The other user's session must not leak through the race path.
      await expect(
        createQuizSession('user-1', SESSION_ID, 'fr-es', answers)
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rethrows any other database error untouched', async () => {
      const dbError = new Error('connection lost');
      mockFindSession.mockResolvedValue(null);
      mockFindLatest.mockResolvedValue(null);
      mockCreate.mockRejectedValue(dbError);

      await expect(createQuizSession('user-1', SESSION_ID, 'fr-es', answers)).rejects.toBe(
        dbError
      );
    });
  });

  // ─────────────────────────────────────────────
  describe('getQuizStats', () => {
    // Answers of the four repository reads, in the shape the repository returns
    // them. Each one defaults to "nothing", so a test only gives what it is about.
    const mockStats = (rows: {
      modes?: unknown[];
      category?: unknown[];
      level?: unknown[];
      missed?: unknown[];
    }) => {
      mockSumByMode.mockResolvedValue(rows.modes ?? []);
      mockCountByCategory.mockResolvedValue(rows.category ?? []);
      mockCountByLevel.mockResolvedValue(rows.level ?? []);
      mockMissedWords.mockResolvedValue(rows.missed ?? []);
    };

    it('returns zeros, null accuracy and empty lists when the user has no session', async () => {
      mockStats({});

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
      mockStats({
        modes: [
          // Deliberately returned in the "wrong" order: the service sorts by QUIZ_MODES.
          {
            mode: 'es-fr',
            sessions: 1,
            score: 5,
            total: 10,
            lastSessionAt: new Date('2026-09-20T08:00:00.000Z'),
          },
          {
            mode: 'fr-es',
            sessions: 2,
            score: 15,
            total: 20,
            lastSessionAt: new Date('2026-10-01T08:00:00.000Z'),
          },
        ],
      });

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
      mockStats({
        category: [
          { key: 'verb', isCorrect: false, count: 4 },
          { key: 'noun', isCorrect: true, count: 33 },
          { key: 'noun', isCorrect: false, count: 7 },
        ],
        level: [
          { key: 'A2', isCorrect: true, count: 3 },
          { key: 'A1', isCorrect: true, count: 9 },
          { key: 'A1', isCorrect: false, count: 1 },
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
      mockStats({
        missed: [
          { wordId: 'v042', wrong: 4 },
          { wordId: 'n001', wrong: 2 },
        ],
      });

      const stats = await getQuizStats('user-1');

      expect(stats.mostMissedWords).toEqual([
        { wordId: 'v042', wrong: 4 },
        { wordId: 'n001', wrong: 2 },
      ]);
    });

    it('filters every query by the given user', async () => {
      mockStats({});

      await getQuizStats('user-1');

      // Every read is made for this user and no other. HOW each query applies the
      // filter (sessions directly, answers through their session) is checked in
      // quizRepository.test.ts. A wrong user here would mix the statistics of users.
      expect(mockSumByMode).toHaveBeenCalledTimes(1);
      expect(mockSumByMode.mock.calls[0][0]).toBe('user-1');
      expect(mockCountByCategory).toHaveBeenCalledTimes(1);
      expect(mockCountByCategory.mock.calls[0][0]).toBe('user-1');
      expect(mockCountByLevel).toHaveBeenCalledTimes(1);
      expect(mockCountByLevel.mock.calls[0][0]).toBe('user-1');
      expect(mockMissedWords).toHaveBeenCalledTimes(1);
      expect(mockMissedWords.mock.calls[0][0]).toBe('user-1');
    });

    it('asks for a bounded number of missed words', async () => {
      mockStats({});

      await getQuizStats('user-1');

      // "Wrong answers only, ordered by count then wordId" is the repository's query,
      // checked in quizRepository.test.ts. The service chooses how many.
      expect(mockMissedWords.mock.calls[0][1]).toBe(MOST_MISSED_LIMIT);
    });
  });
});
