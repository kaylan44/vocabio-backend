// Shared quiz vocabulary: the allowed values, and the shape of one answer.
// See src/types/user.ts for why such shapes live in src/types/.
//
// Why this file also holds VALUES (the arrays), in a folder named "types": the union
// types below are derived from the arrays, so the two cannot be separated. And both
// the service (business rules) and the repository (storage) need the answer type; the
// repository must not import it from the service, which is the layer above it.
//
// Import from this file directly. quizService.ts still re-exports QuizAnswerInput,
// for one existing test only (the reason is written there).

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
export const QUIZ_MODES = ['fr-es', 'es-fr'] as const;
export const QUIZ_CATEGORIES = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'expression',
  'pronoun',
] as const;
export const QUIZ_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;

export type QuizMode = (typeof QUIZ_MODES)[number];
export type QuizCategory = (typeof QUIZ_CATEGORIES)[number];
export type QuizLevel = (typeof QUIZ_LEVELS)[number];

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
