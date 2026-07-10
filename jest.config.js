/** @type {import('jest').Config} */
module.exports = {
  // Utilise ts-jest pour transpiler TypeScript à la volée pendant les tests
  preset: 'ts-jest',

  // Environnement Node.js (pas de DOM, on est côté serveur)
  testEnvironment: 'node',

  // Cherche les fichiers de test dans le dossier tests/
  testMatch: ['**/tests/**/*.test.ts'],

  // Indique à ts-jest d'utiliser notre tsconfig
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        esModuleInterop: true,
        strict: true,
      },
    }],
  },
};
