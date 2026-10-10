// Unit tests of the quiz repository.
//
// Prisma is mocked: these tests check WHICH query is sent (above all: is it filtered
// by the right user?) and how the Prisma result is reshaped. They do NOT check that
// the query is valid SQL, nor that the database really returns rows in the order
// asked. There is no test against a real database in this project yet.

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
      findMany: jest.fn(),
    },
  },
}));

// '@prisma/client' itself is NOT mocked: we need the real error class to build a
// genuine P2002 error, the one the repository detects with `instanceof`.
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/lib/prisma';
import { UniqueConstraintError } from '../../src/repositories/errors';
import {
  countAnswersByCategory,
  countAnswersByLevel,
  createSessionWithAnswers,
  findAnswersOldestFirst,
  findLatestSessionOf,
  findMostMissedWords,
  findSessionById,
  sumSessionsByMode,
} from '../../src/repositories/quizRepository';

const mockFindUnique = prisma.quizSession.findUnique as jest.Mock;
const mockFindFirst = prisma.quizSession.findFirst as jest.Mock;
const mockCreate = prisma.quizSession.create as jest.Mock;
const mockSessionGroupBy = prisma.quizSession.groupBy as jest.Mock;
const mockAnswerGroupBy = prisma.quizAnswer.groupBy as jest.Mock;
const mockAnswerFindMany = prisma.quizAnswer.findMany as jest.Mock;

const SESSION_ID = '3f2b1c7e-8a54-4d2f-9b1a-0c5d6e7f8a90';

const storedSession = {
  id: SESSION_ID,
  userId: 'user-1',
  mode: 'fr-es',
  score: 2,
  total: 3,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
};

const newSession = {
  id: SESSION_ID,
  userId: 'user-1',
  mode: 'fr-es',
  score: 2,
  total: 3,
  answers: [
    { wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true },
    { wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false },
    { wordId: 'n003', category: 'noun', level: 'A1', isCorrect: true },
  ],
};

describe('quizRepository', () => {
  beforeEach(() => jest.resetAllMocks());

  // ─────────────────────────────────────────────
  describe('findSessionById', () => {
    it('looks the session up by id and returns it with its owner', async () => {
      mockFindUnique.mockResolvedValue(storedSession);

      const session = await findSessionById(SESSION_ID);

      expect(mockFindUnique.mock.calls[0][0].where).toEqual({ id: SESSION_ID });
      // userId must come back: the service needs it to check the owner.
      expect(session).toEqual(storedSession);
    });

    it('returns null when the id is free', async () => {
      mockFindUnique.mockResolvedValue(null);

      expect(await findSessionById(SESSION_ID)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  describe('findLatestSessionOf', () => {
    it('asks for the most recent session of the given user only', async () => {
      mockFindFirst.mockResolvedValue(null);

      await findLatestSessionOf('user-1');

      // A wrong `where` here would rate limit a user because of someone else's quiz.
      expect(mockFindFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      });
    });
  });

  // ─────────────────────────────────────────────
  describe('createSessionWithAnswers', () => {
    it('writes the session and its answers in one nested create', async () => {
      mockCreate.mockResolvedValue(storedSession);

      const created = await createSessionWithAnswers(newSession);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const { data } = mockCreate.mock.calls[0][0];
      expect(data).toMatchObject({ id: SESSION_ID, userId: 'user-1', mode: 'fr-es', score: 2, total: 3 });
      expect(created).toEqual(storedSession);
    });

    it('gives each answer its position, 0..n-1, in the given order', async () => {
      mockCreate.mockResolvedValue(storedSession);

      await createSessionWithAnswers(newSession);

      expect(mockCreate.mock.calls[0][0].data.answers.create).toEqual([
        { position: 0, wordId: 'n001', category: 'noun', level: 'A1', isCorrect: true },
        { position: 1, wordId: 'v042', category: 'verb', level: 'A2', isCorrect: false },
        { position: 2, wordId: 'n003', category: 'noun', level: 'A1', isCorrect: true },
      ]);
    });

    it('turns a P2002 into a UniqueConstraintError that says nothing about the schema', async () => {
      mockCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on QuizSession.id', {
          code: 'P2002',
          clientVersion: 'test',
        })
      );

      const error = await createSessionWithAnswers(newSession).catch((e) => e);

      expect(error).toBeInstanceOf(UniqueConstraintError);
      expect(error.message).not.toContain('QuizSession');
    });

    it('lets any other database error through as the same object', async () => {
      const dbError = new Error('connection lost');
      mockCreate.mockRejectedValue(dbError);

      await expect(createSessionWithAnswers(newSession)).rejects.toBe(dbError);
    });
  });

  // ─────────────────────────────────────────────
  describe('statistics', () => {
    it('sumSessionsByMode filters by user and renames the Prisma aggregates', async () => {
      const lastSessionAt = new Date('2026-10-01T08:00:00.000Z');
      mockSessionGroupBy.mockResolvedValue([
        { mode: 'fr-es', _count: { _all: 2 }, _sum: { score: 15, total: 20 }, _max: { createdAt: lastSessionAt } },
      ]);

      const rows = await sumSessionsByMode('user-1');

      expect(mockSessionGroupBy.mock.calls[0][0].where).toEqual({ userId: 'user-1' });
      expect(rows).toEqual([{ mode: 'fr-es', sessions: 2, score: 15, total: 20, lastSessionAt }]);
    });

    it('sumSessionsByMode reads a null sum as 0', async () => {
      mockSessionGroupBy.mockResolvedValue([
        { mode: 'fr-es', _count: { _all: 0 }, _sum: { score: null, total: null }, _max: { createdAt: null } },
      ]);

      expect(await sumSessionsByMode('user-1')).toEqual([
        { mode: 'fr-es', sessions: 0, score: 0, total: 0, lastSessionAt: null },
      ]);
    });

    it('countAnswersByCategory groups by category through the session of the given user', async () => {
      mockAnswerGroupBy.mockResolvedValue([
        { category: 'noun', isCorrect: true, _count: { _all: 33 } },
        { category: 'noun', isCorrect: false, _count: { _all: 7 } },
      ]);

      const rows = await countAnswersByCategory('user-1');

      const query = mockAnswerGroupBy.mock.calls[0][0];
      expect(query.by).toEqual(['category', 'isCorrect']);
      // Answers have no userId column: a missing filter here would mix all users.
      expect(query.where).toEqual({ session: { userId: 'user-1' } });
      expect(rows).toEqual([
        { key: 'noun', isCorrect: true, count: 33 },
        { key: 'noun', isCorrect: false, count: 7 },
      ]);
    });

    it('countAnswersByLevel groups by level through the session of the given user', async () => {
      mockAnswerGroupBy.mockResolvedValue([{ level: 'A1', isCorrect: true, _count: { _all: 9 } }]);

      const rows = await countAnswersByLevel('user-1');

      const query = mockAnswerGroupBy.mock.calls[0][0];
      expect(query.by).toEqual(['level', 'isCorrect']);
      expect(query.where).toEqual({ session: { userId: 'user-1' } });
      expect(rows).toEqual([{ key: 'A1', isCorrect: true, count: 9 }]);
    });

    it('findMostMissedWords asks for wrong answers only, ordered by count then wordId, limited', async () => {
      mockAnswerGroupBy.mockResolvedValue([
        { wordId: 'v042', _count: { wordId: 4 } },
        { wordId: 'n001', _count: { wordId: 2 } },
      ]);

      const rows = await findMostMissedWords('user-1', 10);

      const query = mockAnswerGroupBy.mock.calls[0][0];
      expect(query.where).toEqual({ session: { userId: 'user-1' }, isCorrect: false });
      // The secondary sort on wordId keeps ties in a stable order between calls.
      expect(query.orderBy).toEqual([{ _count: { wordId: 'desc' } }, { wordId: 'asc' }]);
      expect(query.take).toBe(10);
      expect(rows).toEqual([
        { wordId: 'v042', wrong: 4 },
        { wordId: 'n001', wrong: 2 },
      ]);
    });
  });

  // ─────────────────────────────────────────────
  describe('findAnswersOldestFirst', () => {
    it('reads the answers of the given user only, oldest first', async () => {
      mockAnswerFindMany.mockResolvedValue([]);

      await findAnswersOldestFirst('user-1');

      const query = mockAnswerFindMany.mock.calls[0][0];
      expect(query.where).toEqual({ session: { userId: 'user-1' } });
      // The streak computed by the service is only right in chronological order.
      expect(query.orderBy).toEqual([
        { session: { createdAt: 'asc' } },
        { sessionId: 'asc' },
        { position: 'asc' },
      ]);
    });

    it('flattens the session of each answer into mode and createdAt', async () => {
      const createdAt = new Date('2026-10-01T10:00:00.000Z');
      mockAnswerFindMany.mockResolvedValue([
        { wordId: 'n001', isCorrect: true, session: { mode: 'es-fr', createdAt } },
      ]);

      expect(await findAnswersOldestFirst('user-1')).toEqual([
        { wordId: 'n001', isCorrect: true, mode: 'es-fr', createdAt },
      ]);
    });
  });
});
