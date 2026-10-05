// Unit tests of quizService.getWordProgress.
//
// Kept apart from quizService.test.ts so that file stays untouched. Prisma is
// mocked: these tests check how the answers are folded into counters, NOT that the
// query really returns them oldest first (the test hands them over already sorted,
// as the database is asked to).

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    quizAnswer: {
      findMany: jest.fn(),
    },
  },
}));

import { getWordProgress } from '../../src/services/quizService';
import { prisma } from '../../src/lib/prisma';

const mockFindMany = prisma.quizAnswer.findMany as jest.Mock;

const DAY_1 = new Date('2026-10-01T10:00:00.000Z');
const DAY_2 = new Date('2026-10-02T10:00:00.000Z');
const DAY_3 = new Date('2026-10-03T10:00:00.000Z');

// An answer as Prisma returns it with the service's select.
const answer = (wordId: string, isCorrect: boolean, mode = 'fr-es', createdAt = DAY_1) => ({
  wordId,
  isCorrect,
  session: { mode, createdAt },
});

describe('quizService.getWordProgress', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns an empty array for a user with no finished quiz', async () => {
    mockFindMany.mockResolvedValue([]);

    expect(await getWordProgress('user-1')).toEqual([]);
  });

  it('counts the answers and the correct ones of a word', async () => {
    mockFindMany.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', false, 'fr-es', DAY_2),
      answer('n001', true, 'fr-es', DAY_3),
    ]);

    expect(await getWordProgress('user-1')).toEqual([
      {
        wordId: 'n001',
        mode: 'fr-es',
        correctStreak: 1,
        totalSeen: 3,
        totalCorrect: 2,
        lastSeenAt: DAY_3,
      },
    ]);
  });

  it('counts a streak of correct answers', async () => {
    mockFindMany.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', true, 'fr-es', DAY_2),
      answer('n001', true, 'fr-es', DAY_3),
    ]);

    const [row] = await getWordProgress('user-1');

    expect(row.correctStreak).toBe(3);
  });

  it('puts the streak back to 0 when the latest answer is wrong', async () => {
    mockFindMany.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', true, 'fr-es', DAY_2),
      answer('n001', false, 'fr-es', DAY_3),
    ]);

    const [row] = await getWordProgress('user-1');

    expect(row).toMatchObject({ correctStreak: 0, totalSeen: 3, totalCorrect: 2 });
  });

  it('restarts the streak after a wrong answer instead of resuming the old one', async () => {
    mockFindMany.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', false, 'fr-es', DAY_2),
      answer('n001', true, 'fr-es', DAY_3),
    ]);

    const [row] = await getWordProgress('user-1');

    expect(row.correctStreak).toBe(1);
  });

  it('tracks fr-es and es-fr separately for the same word', async () => {
    mockFindMany.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', false, 'es-fr', DAY_2),
      answer('n001', true, 'fr-es', DAY_3),
    ]);

    const rows = await getWordProgress('user-1');

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.mode === 'fr-es')).toMatchObject({
      correctStreak: 2,
      totalSeen: 2,
      totalCorrect: 2,
      lastSeenAt: DAY_3,
    });
    expect(rows.find((row) => row.mode === 'es-fr')).toMatchObject({
      correctStreak: 0,
      totalSeen: 1,
      totalCorrect: 0,
      lastSeenAt: DAY_2,
    });
  });

  it('keeps the counters of different words apart', async () => {
    mockFindMany.mockResolvedValue([
      answer('n001', true),
      answer('v042', false),
      answer('n001', true),
    ]);

    const rows = await getWordProgress('user-1');

    expect(rows.find((row) => row.wordId === 'n001')).toMatchObject({ totalSeen: 2, correctStreak: 2 });
    expect(rows.find((row) => row.wordId === 'v042')).toMatchObject({ totalSeen: 1, correctStreak: 0 });
  });

  it('reads the answers of the given user only, oldest first', async () => {
    mockFindMany.mockResolvedValue([]);

    await getWordProgress('user-1');

    const query = mockFindMany.mock.calls[0][0];
    expect(query.where).toEqual({ session: { userId: 'user-1' } });
    // The streak is only right if the answers are folded in chronological order.
    expect(query.orderBy).toEqual([
      { session: { createdAt: 'asc' } },
      { sessionId: 'asc' },
      { position: 'asc' },
    ]);
  });
});
