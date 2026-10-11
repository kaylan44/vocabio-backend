// Unit tests of quizService.getWordProgress.
//
// Kept apart from quizService.test.ts so that file stays untouched. The repository
// is mocked: these tests check how the answers are folded into counters, NOT that the
// query really returns them oldest first (the test hands them over already sorted, as
// the repository promises to). That the query asks for this order, for this user only,
// is checked in tests/repositories/quizRepository.test.ts.

jest.mock('../../src/repositories/quizRepository', () => ({
  findAnswersOldestFirst: jest.fn(),
}));

import { getWordProgress } from '../../src/services/quizService';
import { findAnswersOldestFirst } from '../../src/repositories/quizRepository';

const mockFindAnswers = findAnswersOldestFirst as jest.Mock;

const DAY_1 = new Date('2026-10-01T10:00:00.000Z');
const DAY_2 = new Date('2026-10-02T10:00:00.000Z');
const DAY_3 = new Date('2026-10-03T10:00:00.000Z');

// An answer as the repository returns it: with the mode and the date of its session.
const answer = (wordId: string, isCorrect: boolean, mode = 'fr-es', createdAt = DAY_1) => ({
  wordId,
  isCorrect,
  mode,
  createdAt,
});

describe('quizService.getWordProgress', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns an empty array for a user with no finished quiz', async () => {
    mockFindAnswers.mockResolvedValue([]);

    expect(await getWordProgress('user-1')).toEqual([]);
  });

  it('counts the answers and the correct ones of a word', async () => {
    mockFindAnswers.mockResolvedValue([
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
    mockFindAnswers.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', true, 'fr-es', DAY_2),
      answer('n001', true, 'fr-es', DAY_3),
    ]);

    const [row] = await getWordProgress('user-1');

    expect(row.correctStreak).toBe(3);
  });

  it('puts the streak back to 0 when the latest answer is wrong', async () => {
    mockFindAnswers.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', true, 'fr-es', DAY_2),
      answer('n001', false, 'fr-es', DAY_3),
    ]);

    const [row] = await getWordProgress('user-1');

    expect(row).toMatchObject({ correctStreak: 0, totalSeen: 3, totalCorrect: 2 });
  });

  it('restarts the streak after a wrong answer instead of resuming the old one', async () => {
    mockFindAnswers.mockResolvedValue([
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', true, 'fr-es', DAY_1),
      answer('n001', false, 'fr-es', DAY_2),
      answer('n001', true, 'fr-es', DAY_3),
    ]);

    const [row] = await getWordProgress('user-1');

    expect(row.correctStreak).toBe(1);
  });

  it('tracks fr-es and es-fr separately for the same word', async () => {
    mockFindAnswers.mockResolvedValue([
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
    mockFindAnswers.mockResolvedValue([
      answer('n001', true),
      answer('v042', false),
      answer('n001', true),
    ]);

    const rows = await getWordProgress('user-1');

    expect(rows.find((row) => row.wordId === 'n001')).toMatchObject({ totalSeen: 2, correctStreak: 2 });
    expect(rows.find((row) => row.wordId === 'v042')).toMatchObject({ totalSeen: 1, correctStreak: 0 });
  });

  it('reads the answers of the given user only', async () => {
    mockFindAnswers.mockResolvedValue([]);

    await getWordProgress('user-1');

    // The chronological order the streak depends on is the repository's query,
    // checked in quizRepository.test.ts.
    expect(mockFindAnswers).toHaveBeenCalledTimes(1);
    expect(mockFindAnswers).toHaveBeenCalledWith('user-1');
  });
});
