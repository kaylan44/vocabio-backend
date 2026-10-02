// Quiz session routes.
//
// POST /quiz-sessions        → store the result of a finished quiz
// GET  /quiz-sessions/stats  → aggregated statistics of the signed-in user
//
// No assertParticipant here: no conversation is involved. The protection is that
// the user id always comes from req.user.id (the JWT), never from the body or the
// URL, so a user can neither write nor read someone else's results.

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  createQuizSession,
  getQuizStats,
  MAX_ANSWERS_PER_SESSION,
  QUIZ_CATEGORIES,
  QUIZ_LEVELS,
  QUIZ_MODES,
  QuizAnswerInput,
  QuizCategory,
  QuizLevel,
  QuizMode,
} from '../services/quizService';
import { handleError } from '../utils/errors';

const router = Router();

router.use(authMiddleware);

// Standard UUID shape (8-4-4-4-12 hexadecimal characters), any version.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Word ids look like 'n001' today; 20 leaves room without accepting arbitrary text.
const MAX_WORD_ID_LENGTH = 20;

// `typeof null` is 'object' in JavaScript, and an array is an object too:
// both must be excluded before we can safely read a property.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `includes` on a readonly tuple only accepts its own literal type, so we widen
// the list to string[] to be able to test an arbitrary value.
const isOneOf = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value);

type ValidationResult =
  | { ok: false; error: string }
  | { ok: true; id: string; mode: QuizMode; answers: QuizAnswerInput[] };

// ─────────────────────────────────────────────
// Helper: validate the body of POST /quiz-sessions
// ─────────────────────────────────────────────
// This function must NEVER throw. With Express 4, an exception thrown in an async
// handler outside its try/catch becomes an unhandled promise rejection: the request
// hangs and Node may stop the process. That is why every value is type-checked
// BEFORE its fields are read (e.g. `{ "answers": [null] }` must give a 400, not a
// "cannot read properties of null").
//
// It returns either an error message or the payload with its final types, so the
// handler does not need any cast.
const validateQuizSessionBody = (body: unknown): ValidationResult => {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'The request body must be a JSON object' };
  }

  const { id, mode, answers } = body;

  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    return { ok: false, error: 'id must be a UUID' };
  }

  if (!isOneOf(QUIZ_MODES, mode)) {
    return { ok: false, error: `mode must be one of: ${QUIZ_MODES.join(', ')}` };
  }

  if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_ANSWERS_PER_SESSION) {
    return {
      ok: false,
      error: `answers must be an array of 1 to ${MAX_ANSWERS_PER_SESSION} items`,
    };
  }

  const validAnswers: QuizAnswerInput[] = [];

  // A repeated wordId inside one session is allowed on purpose: rejecting it would
  // tie the backend to how the app builds a quiz today (it may re-ask a missed word).
  for (const [index, answer] of answers.entries()) {
    if (!isPlainObject(answer)) {
      return { ok: false, error: `answers[${index}] must be an object` };
    }

    const { wordId, category, level, isCorrect } = answer;

    if (typeof wordId !== 'string' || wordId.length === 0 || wordId.length > MAX_WORD_ID_LENGTH) {
      return {
        ok: false,
        error: `answers[${index}].wordId must be a non-empty string of at most ${MAX_WORD_ID_LENGTH} characters`,
      };
    }

    if (!isOneOf(QUIZ_CATEGORIES, category)) {
      return {
        ok: false,
        error: `answers[${index}].category must be one of: ${QUIZ_CATEGORIES.join(', ')}`,
      };
    }

    if (!isOneOf(QUIZ_LEVELS, level)) {
      return {
        ok: false,
        error: `answers[${index}].level must be one of: ${QUIZ_LEVELS.join(', ')}`,
      };
    }

    // Strictly a boolean: "true", 1 or null are rejected rather than coerced, a
    // wrong type here would silently corrupt the statistics.
    if (typeof isCorrect !== 'boolean') {
      return { ok: false, error: `answers[${index}].isCorrect must be a boolean` };
    }

    // We rebuild the object field by field: any extra property sent by the client
    // is dropped instead of travelling to the service.
    validAnswers.push({
      wordId,
      category: category as QuizCategory,
      level: level as QuizLevel,
      isCorrect,
    });
  }

  return {
    ok: true,
    // Lowercased: 'ABC…' and 'abc…' are the same UUID but would be two different
    // primary keys, which would defeat the idempotency.
    id: id.toLowerCase(),
    mode: mode as QuizMode,
    answers: validAnswers,
  };
};

// ─────────────────────────────────────────────
// POST /quiz-sessions
// Expected body: { id, mode, answers: [{ wordId, category, level, isCorrect }] }
// ─────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const validation = validateQuizSessionBody(req.body);

  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const { session, created } = await createQuizSession(
      req.user.id,
      validation.id,
      validation.mode,
      validation.answers
    );

    // 201 Created the first time, 200 OK when the same quiz is sent again:
    // the client can treat both as a success.
    res.status(created ? 201 : 200).json(session);
  } catch (error) {
    handleError(res, error, 'POST /quiz-sessions');
  }
});

// ─────────────────────────────────────────────
// GET /quiz-sessions/stats
// ─────────────────────────────────────────────
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getQuizStats(req.user.id);
    res.json(stats);
  } catch (error) {
    handleError(res, error, 'GET /quiz-sessions/stats');
  }
});

export default router;
