// Tests of the quiz vocabulary (src/types/quiz.ts).
//
// The language of a quiz is derived from its mode through QUIZ_MODES_BY_LANGUAGE.
// TypeScript already checks that every language has an entry and that each listed
// mode exists. What it cannot check is the other direction, tested here: a mode
// added to QUIZ_MODES but forgotten in the mapping would be accepted by
// POST /quiz-sessions and then counted in no language's statistics.

import {
  languageOfMode,
  QUIZ_LANGUAGES,
  QUIZ_MODES,
  QUIZ_MODES_BY_LANGUAGE,
} from '../../src/types/quiz';

describe('QUIZ_MODES_BY_LANGUAGE', () => {
  it.each(QUIZ_MODES)('puts the mode %s in exactly one language', (mode) => {
    const languages = QUIZ_LANGUAGES.filter((lang) => QUIZ_MODES_BY_LANGUAGE[lang].includes(mode));

    expect(languages).toHaveLength(1);
  });

  it('maps each language to its own two directions', () => {
    // Written out by value: a swapped or misspelled mapping must fail here.
    expect(QUIZ_MODES_BY_LANGUAGE).toEqual({
      es: ['fr-es', 'es-fr'],
      id: ['fr-id', 'id-fr'],
    });
  });
});

describe('languageOfMode', () => {
  // By value, both directions of each language: the route builds the expected word id
  // prefix from this answer.
  it.each([
    ['fr-es', 'es'],
    ['es-fr', 'es'],
    ['fr-id', 'id'],
    ['id-fr', 'id'],
  ] as const)('gives %s the language %s', (mode, language) => {
    expect(languageOfMode(mode)).toBe(language);
  });
});
