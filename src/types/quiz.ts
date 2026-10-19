// Shared quiz vocabulary: the allowed values, the shape of one answer, and what the
// three quiz endpoints answer.
// See src/types/user.ts for why such shapes live in src/types/.
//
// Why this file also holds VALUES (the arrays), in a folder named "types": the union
// types below are derived from the arrays, so the two cannot be separated. And both
// the service (business rules) and the repository (storage) need the answer type; the
// repository must not import it from the service, which is the layer above it.
//
// Import from this file directly: quizService.ts does not re-export anything from it.

// ─────────────────────────────────────────────
// Allowed values
// ─────────────────────────────────────────────
// These lists mirror the types of the mobile app (vocabio2, types/index.ts).
// They are plain strings in the database (see prisma/schema.prisma for why not
// enums), so the route validating against these lists is the only place where an
// unknown value gets rejected.
//
// Pitfall: a new mode, category or level in the app requires this backend to be
// deployed FIRST. Otherwise the route answers 400 and the quiz result is lost.
//
// `as const` turns each array into a tuple of literal types, which lets us derive
// the union types below instead of writing the same values twice.
//
// Order matters for QUIZ_MODES: `byMode` in the statistics follows it. New modes are
// appended, so the order the app already shows does not move.
export const QUIZ_MODES = ['fr-es', 'es-fr', 'fr-id', 'id-fr'] as const;
export const QUIZ_CATEGORIES = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'expression',
  'pronoun',
  'number',
] as const;
export const QUIZ_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;

export type QuizMode = (typeof QUIZ_MODES)[number];
export type QuizCategory = (typeof QUIZ_CATEGORIES)[number];
export type QuizLevel = (typeof QUIZ_LEVELS)[number];

// ─────────────────────────────────────────────
// Languages
// ─────────────────────────────────────────────
// The language learned in a quiz is not stored anywhere: it is derived from the mode
// ('fr-id' and 'id-fr' are Indonesian). A `language` column was rejected: it would
// repeat what the mode already says, and the two could one day contradict each other.
//
// Pitfall: a new mode must be added to QUIZ_MODES AND to one language below.
// tests/types/quiz.test.ts fails if a mode belongs to no language, or to two.
export const QUIZ_LANGUAGES = ['es', 'id'] as const;

export type QuizLanguage = (typeof QUIZ_LANGUAGES)[number];

// `Record<QuizLanguage, ...>`: forgetting a language of QUIZ_LANGUAGES here does not
// compile. `readonly QuizMode[]`: a typo in a mode does not compile either.
export const QUIZ_MODES_BY_LANGUAGE: Record<QuizLanguage, readonly QuizMode[]> = {
  es: ['fr-es', 'es-fr'],
  id: ['fr-id', 'id-fr'],
};

// The other direction: the language of a mode. Read from QUIZ_MODES_BY_LANGUAGE
// rather than from the letters of the mode ('fr-id'.slice(-2) would also work today):
// the mapping above stays the only place that says which mode is which language.
// A function in a "types" folder, exceptionally: it is a lookup in the table above,
// with no logic of its own, and both the route and the tests need it.
export const languageOfMode = (mode: QuizMode): QuizLanguage => {
  const language = QUIZ_LANGUAGES.find((lang) => QUIZ_MODES_BY_LANGUAGE[lang].includes(mode));
  // Unreachable while tests/types/quiz.test.ts passes (every mode has one language).
  // Thrown rather than returning a default: a wrong language would silently file
  // the answers under the wrong statistics.
  if (!language) {
    throw new Error(`No language declared for the quiz mode ${mode}`);
  }
  return language;
};

// ─────────────────────────────────────────────
// One answer of a quiz
// ─────────────────────────────────────────────
// As sent by the app and as stored. These precise types hold on the WRITE side only,
// where the route has validated the values. Rows read back from the database are
// typed `string` (see quizRepository.ts): a String column guarantees nothing more.
export interface QuizAnswerInput {
  wordId: string;
  category: QuizCategory;
  level: QuizLevel;
  isCorrect: boolean;
}

// ─────────────────────────────────────────────
// What the client receives
// ─────────────────────────────────────────────
// The return types of quizService, i.e. the JSON of the three quiz endpoints (see
// README.md, "Quiz results"). They are written by hand and given to the service
// functions as EXPLICIT return types, for two reasons:
//   - the contract with the app is readable in one place, instead of being whatever
//     the last `return` of each function happens to build;
//   - changing a response by accident (renaming a field, dropping one) becomes a
//     compile error in the service, not a surprise in the app.
// What an explicit return type does NOT do: it does not stop an object from carrying
// MORE fields than declared when it is built by spreading another object. What keeps
// these responses exact is that every field is listed somewhere: in the service, or
// in the `select` of the repository for the session.
//
// `mode`, `category` and `level` are `string` here, not QuizMode / QuizCategory /
// QuizLevel: these values are read back from String columns (see the note above
// QuizAnswerInput).

// A stored session, as answered by POST /quiz-sessions. No `userId`: the client
// already knows who it is, and the id of another user must never leave the server.
export interface QuizSessionSummary {
  id: string;
  mode: string;
  score: number; // number of correct answers
  total: number; // number of questions
  createdAt: Date;
}

export interface CreateQuizSessionResult {
  session: QuizSessionSummary;
  // false when the session was already stored (replay): the route answers 200
  // instead of 201.
  created: boolean;
}

// Counters shared by every breakdown of the statistics.
export interface AccuracyTotals {
  answers: number;
  correct: number;
  // Ratio rounded to 3 decimals. null when there is no answer: "no data" is not 0 %.
  accuracy: number | null;
}

export interface ModeStats extends AccuracyTotals {
  mode: string;
  sessions: number;
}

export interface CategoryStats extends AccuracyTotals {
  category: string;
}

export interface LevelStats extends AccuracyTotals {
  level: string;
}

// A word and how many times the user answered it wrong. Only the id: the app owns
// the vocabulary and resolves it to the actual word.
export interface MissedWord {
  wordId: string;
  wrong: number;
}

// Answer of GET /quiz-sessions/stats.
export interface QuizStats {
  totalSessions: number;
  totalAnswers: number;
  totalCorrect: number;
  accuracy: number | null;
  lastSessionAt: Date | null; // null when the user has no session
  byMode: ModeStats[];
  byCategory: CategoryStats[];
  byLevel: LevelStats[];
  mostMissedWords: MissedWord[];
}

// One entry of GET /quiz-sessions/word-progress: one word in one translation direction.
export interface WordProgress {
  wordId: string;
  mode: string;
  correctStreak: number; // correct answers in a row, back to 0 on a wrong one
  totalSeen: number;
  totalCorrect: number;
  lastSeenAt: Date;
}
