// Architecture guard: only the repositories may talk to Prisma.
//
// The rule "routes → services → repositories → prisma" is easy to break without
// noticing: one `import { prisma }` in a service or a middleware works perfectly and
// no other test fails. This test reads the source files and fails as soon as a file
// outside src/repositories/ imports Prisma.
//
// Same idea as tests/prisma/rls.test.ts: no database is needed, we check the source
// of truth (here, the imports).
//
// What it does NOT prove:
//   - that a repository is free of business logic;
//   - that Prisma is not reached INDIRECTLY: if a repository re-exported `prisma` and
//     a service imported it from that repository, this test would stay green. It only
//     looks at what each file imports, not at what the imported file hands over.
// Both stay a matter of code review.

import fs from 'fs';
import path from 'path';

const SRC_DIR = path.join(__dirname, '../../src');

// The file that creates the PrismaClient singleton, without its extension.
const PRISMA_SINGLETON = path.join(SRC_DIR, 'lib', 'prisma');

// Files outside src/repositories/ that are allowed to import Prisma, each with the
// reason. Adding a line here is a decision to discuss in review, not a quick fix.
const ALLOWED = new Set([
  // Creates the PrismaClient singleton: it IS the access point the repositories use.
  'lib/prisma.ts',
  // Calls prisma.$disconnect() when the one-shot command ends. That is the lifecycle
  // of the connection pool, not a query on data.
  'jobs/syncArticles.ts',
]);

// ─────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────

// Every module path a file refers to, whatever the syntax:
//   import x from '...'      export { x } from '...'     → `from`
//   await import('...')                                  → `import(`
//   require('...')                                       → `require(`
//   import '...'             (side-effect import)        → `import` + quote
//
// A regular expression, not a real TypeScript parser: it also matches inside a
// comment or a string. That can only make the guard stricter (a false alarm, visible
// at once), never let an import through.
const MODULE_PATH =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

const importedPaths = (source: string): string[] =>
  Array.from(source.matchAll(MODULE_PATH), (match) => match[2]);

/**
 * Whether `modulePath`, written in the file `file` (relative to src/), is Prisma.
 *
 * Why the paths are RESOLVED instead of compared as text: the same file can be
 * written '../lib/prisma' from a service, './prisma' from src/lib/, or
 * '../lib/prisma.js'. Comparing text catches one spelling and misses the others.
 */
const isPrismaPath = (modulePath: string, file: string): boolean => {
  // The package, and anything inside it: '@prisma/client/runtime/library' is where
  // the error classes can also be imported from. '.prisma/client' is the generated
  // client the package re-exports.
  for (const packageName of ['@prisma/client', '.prisma/client']) {
    if (modulePath === packageName || modulePath.startsWith(`${packageName}/`)) {
      return true;
    }
  }

  // Our singleton, reached through a relative path.
  if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
    const fromDir = path.dirname(path.join(SRC_DIR, file));
    const resolved = path.resolve(fromDir, modulePath).replace(/\.(?:ts|js|mjs|cjs)$/, '');
    return resolved === PRISMA_SINGLETON;
  }

  return false;
};

const importsPrisma = (source: string, file: string): boolean =>
  importedPaths(source).some((modulePath) => isPrismaPath(modulePath, file));

// Every .ts file under `dir`, as paths relative to src/ with forward slashes (so the
// test gives the same result on Windows and Linux).
const listSourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath);
    }
    return entry.name.endsWith('.ts')
      ? [path.relative(SRC_DIR, fullPath).split(path.sep).join('/')]
      : [];
  });

// ─────────────────────────────────────────────
// The detector itself
// ─────────────────────────────────────────────
// A guard that silently detects nothing is worse than no guard: it gives confidence
// without checking anything. So the detector is tested on its own, on small pieces of
// code, before being trusted on the real files.
describe('Prisma import detector', () => {
  it.each([
    ['a named import of the singleton', 'services/x.ts', `import { prisma } from '../lib/prisma';`],
    ['double quotes', 'services/x.ts', `import { prisma } from "../lib/prisma";`],
    ['an import split over several lines', 'services/x.ts', `import {\n  prisma,\n} from '../lib/prisma';`],
    ['the singleton from a neighbour file in src/lib/', 'lib/socket.ts', `import { prisma } from './prisma';`],
    ['the singleton from a deeper folder', 'services/quiz/x.ts', `import { prisma } from '../../lib/prisma';`],
    ['a path with an extension', 'services/x.ts', `import { prisma } from '../lib/prisma.js';`],
    ['a dynamic import', 'services/x.ts', `const { prisma } = await import('../lib/prisma');`],
    ['a require', 'services/x.ts', `const { prisma } = require('../lib/prisma');`],
    ['a re-export', 'services/x.ts', `export { prisma } from '../lib/prisma';`],
    ['the Prisma package', 'services/x.ts', `import { Prisma } from '@prisma/client';`],
    ['a type-only import of the package', 'services/x.ts', `import type { User } from '@prisma/client';`],
    ['a sub-path of the package', 'services/x.ts', `import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';`],
    ['the generated client', 'services/x.ts', `import { PrismaClient } from '.prisma/client';`],
  ])('detects %s', (_label, file, source) => {
    expect(importsPrisma(source, file)).toBe(true);
  });

  it.each([
    ['another file of src/lib/', 'services/x.ts', `import { getIO } from '../lib/socket';`],
    ['a repository', 'services/x.ts', `import * as quizRepository from '../repositories/quizRepository';`],
    // Same spelling as the neighbour case above, but from src/services/ it points to
    // src/services/prisma, which is not the singleton.
    ['a file merely named prisma elsewhere', 'services/x.ts', `import { helper } from './prisma';`],
    ['a package with a similar name', 'services/x.ts', `import { x } from '@prisma-tools/client';`],
    ['no import at all', 'services/x.ts', `export const answer = 42;`],
  ])('ignores %s', (_label, file, source) => {
    expect(importsPrisma(source, file)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// The real source files
// ─────────────────────────────────────────────
describe('Prisma access boundary', () => {
  const files = listSourceFiles(SRC_DIR);
  const filesImportingPrisma = files.filter((file) =>
    importsPrisma(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'), file)
  );

  it('finds the source files and detects Prisma imports (otherwise this guard proves nothing)', () => {
    expect(files).toContain('services/quizService.ts');
    // The repositories DO import Prisma: if none is detected, the detector is broken.
    expect(filesImportingPrisma).toContain('repositories/quizRepository.ts');
    expect(filesImportingPrisma).toContain('lib/prisma.ts');
  });

  it('lets no file outside src/repositories/ import Prisma', () => {
    const offenders = filesImportingPrisma.filter(
      (file) => !file.startsWith('repositories/') && !ALLOWED.has(file)
    );

    // On failure, the message lists the files: move their queries to a repository.
    expect(offenders).toEqual([]);
  });

  it('keeps the list of exceptions honest: each one still exists and still imports Prisma', () => {
    // An exception that is no longer needed must be removed from ALLOWED, otherwise
    // the list would silently allow a future import in that file.
    for (const file of ALLOWED) {
      expect(filesImportingPrisma).toContain(file);
    }
  });
});
