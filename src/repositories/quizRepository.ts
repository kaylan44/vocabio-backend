// Quiz repository: every query on the QuizSession and QuizAnswer tables.
//
// Same rule as the other repositories (see userRepository.ts): Prisma only. What is
// NOT here, on purpose: who owns a session (409), the rate limit (429), how score and
// accuracy are computed. Those are business rules and stay in quizService.
//
// Security note: every function reading quiz data takes `userId` as a REQUIRED
// parameter and filters by it. There is deliberately no "all users" variant, so a
// service cannot forget the filter and mix the statistics of several users.
// Sessions are filtered directly, answers through their session
// (`session: { userId }`), because QuizAnswer has no userId column.

import { prisma } from '../lib/prisma';
import { QuizAnswerInput, QuizMode } from '../types/quiz';
import { toRepositoryError } from './errors';

// ─────────────────────────────────────────────
// Shapes exchanged with the service
// ─────────────────────────────────────────────
// They stay in this file, unlike the shapes of src/types/: each one describes the
// input or the result of ONE query below and is read by quizService only. Keeping
// them next to the query avoids opening two files to change one.
//
// Read side and write side are typed differently on purpose. What is WRITTEN uses
// the precise types (QuizMode, QuizAnswerInput): the route validated the values.
// What is READ is typed `string`: `mode`, `category` and `level` are String columns,
// which guarantee nothing about their content.

// A session as stored. `userId` is included so the service can check the owner; the
// service removes it before answering the client.
export interface StoredQuizSession {
  id: string;
  userId: string;
  mode: string;
  score: number;
  total: number;
  createdAt: Date;
}

export interface NewQuizSession {
  id: string;
  userId: string;
  mode: QuizMode;
  score: number;
  total: number;
  // In the order the questions were asked: the index becomes `position`.
  answers: QuizAnswerInput[];
}

export interface ModeTotals {
  mode: string;
  sessions: number; // number of sessions in this mode
  score: number; // sum of the scores (correct answers)
  total: number; // sum of the totals (questions asked)
  lastSessionAt: Date | null;
}

// One row of a GROUP BY (column, isCorrect). `key` is the value of the grouped column
// (a category or a level): one generic name so the service folds both the same way.
export interface AnswerCount {
  key: string;
  isCorrect: boolean;
  count: number;
}

export interface MissedWord {
  wordId: string;
  wrong: number;
}

export interface ChronologicalAnswer {
  wordId: string;
  isCorrect: boolean;
  mode: string; // mode of the session the answer belongs to
  createdAt: Date; // date of that session
}

const SESSION_SELECT = {
  id: true,
  userId: true,
  mode: true,
  score: true,
  total: true,
  createdAt: true,
} as const;

// ─────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────

/**
 * The session with this id, WHOEVER owns it, or null.
 *
 * It is the one read that is not filtered by user: the id is the idempotency key, and
 * the service needs to know that it is taken even when it belongs to someone else.
 * The caller must check `userId` before returning anything (see resolveExisting).
 */
export const findSessionById = async (sessionId: string): Promise<StoredQuizSession | null> => {
  return prisma.quizSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
};

/**
 * Id and date of the most recent session of a user, or null if they have none.
 * Served by @@index([userId, createdAt]).
 */
export const findLatestSessionOf = async (
  userId: string
): Promise<{ id: string; createdAt: Date } | null> => {
  return prisma.quizSession.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
};

/**
 * Stores a session and all its answers.
 *
 * One nested create = one transaction. Either the session and all its answers are
 * stored, or nothing is: no session without its answers. This is why it is ONE
 * repository function and not "create the session" then "create the answers".
 *
 * @throws UniqueConstraintError if a session with this id already exists
 */
export const createSessionWithAnswers = async (
  session: NewQuizSession
): Promise<StoredQuizSession> => {
  try {
    return await prisma.quizSession.create({
      data: {
        id: session.id,
        userId: session.userId,
        mode: session.mode,
        score: session.score,
        total: session.total,
        answers: {
          create: session.answers.map((answer, position) => ({
            position, // index in the array = order of the question in the quiz
            wordId: answer.wordId,
            category: answer.category,
            level: answer.level,
            isCorrect: answer.isCorrect,
          })),
        },
      },
      select: SESSION_SELECT,
    });
  } catch (error) {
    throw toRepositoryError(error);
  }
};

// ─────────────────────────────────────────────
// Aggregates for the statistics
// ─────────────────────────────────────────────
// Each function below is one GROUP BY. Prisma returns aggregates under `_count`,
// `_sum` and `_max`; they are renamed here so the service handles plain numbers.

/**
 * Totals of a user's sessions, one row per mode.
 * score and total are stored on the session, so these totals need no join.
 */
export const sumSessionsByMode = async (userId: string): Promise<ModeTotals[]> => {
  const rows = await prisma.quizSession.groupBy({
    by: ['mode'],
    where: { userId },
    _count: { _all: true },
    _sum: { score: true, total: true },
    _max: { createdAt: true },
  });

  return rows.map((row) => ({
    mode: row.mode,
    sessions: row._count._all,
    // _sum is null when the group is empty; cannot happen for an existing group,
    // but the generated type says "number | null", hence the fallback.
    score: row._sum.score ?? 0,
    total: row._sum.total ?? 0,
    lastSessionAt: row._max.createdAt,
  }));
};

/**
 * Number of answers of a user per (category, isCorrect): up to two rows per category.
 */
export const countAnswersByCategory = async (userId: string): Promise<AnswerCount[]> => {
  const rows = await prisma.quizAnswer.groupBy({
    by: ['category', 'isCorrect'],
    where: { session: { userId } },
    _count: { _all: true },
  });

  return rows.map((row) => ({
    key: row.category,
    isCorrect: row.isCorrect,
    count: row._count._all,
  }));
};

/**
 * Number of answers of a user per (level, isCorrect): up to two rows per level.
 */
export const countAnswersByLevel = async (userId: string): Promise<AnswerCount[]> => {
  const rows = await prisma.quizAnswer.groupBy({
    by: ['level', 'isCorrect'],
    where: { session: { userId } },
    _count: { _all: true },
  });

  return rows.map((row) => ({
    key: row.level,
    isCorrect: row.isCorrect,
    count: row._count._all,
  }));
};

/**
 * The words a user answered wrong most often, most missed first.
 *
 * Secondary sort on wordId: without it, words with the same count could come back in
 * a different order on each call.
 *
 * @param limit - Maximum number of words; the value is chosen by the service
 */
export const findMostMissedWords = async (userId: string, limit: number): Promise<MissedWord[]> => {
  const rows = await prisma.quizAnswer.groupBy({
    by: ['wordId'],
    where: { session: { userId }, isCorrect: false },
    _count: { wordId: true },
    orderBy: [{ _count: { wordId: 'desc' } }, { wordId: 'asc' }],
    take: limit,
  });

  return rows.map((row) => ({
    wordId: row.wordId,
    wrong: row._count.wordId,
  }));
};

// ─────────────────────────────────────────────
// Answers
// ─────────────────────────────────────────────

/**
 * Every answer of a user, oldest first, each with the mode and date of its session.
 *
 * The order is part of the contract: the service computes a streak from it.
 * Oldest first, then the order of the questions inside a quiz. sessionId breaks the
 * tie between two sessions created at the same millisecond, so their answers are
 * never interleaved.
 */
export const findAnswersOldestFirst = async (userId: string): Promise<ChronologicalAnswer[]> => {
  const answers = await prisma.quizAnswer.findMany({
    where: { session: { userId } },
    select: {
      wordId: true,
      isCorrect: true,
      session: { select: { mode: true, createdAt: true } },
    },
    orderBy: [{ session: { createdAt: 'asc' } }, { sessionId: 'asc' }, { position: 'asc' }],
  });

  return answers.map((answer) => ({
    wordId: answer.wordId,
    isCorrect: answer.isCorrect,
    mode: answer.session.mode,
    createdAt: answer.session.createdAt,
  }));
};
