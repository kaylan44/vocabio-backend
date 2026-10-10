// Architecture guard: only the repositories may talk to Prisma.
//
// The rule "routes → services → repositories → prisma" is easy to break without
// noticing: one `import { prisma }` in a service or a middleware works perfectly and
// no other test fails. This test reads the source files and fails as soon as a file
// outside src/repositories/ imports Prisma.
//
// Same idea as tests/prisma/rls.test.ts: no database is needed, we check the source
// of truth (here, the imports). What it does NOT prove: that a repository is free of
// business logic. That part stays a matter of code review.

import fs from 'fs';
import path from 'path';

const SRC_DIR = path.join(__dirname, '../../src');

// Files outside src/repositories/ that are allowed to import Prisma, each with the
// reason. Adding a line here is a decision to discuss in review, not a quick fix.
const ALLOWED = new Set([
  // Creates the PrismaClient singleton: it IS the access point the repositories use.
  'lib/prisma.ts',
  // Calls prisma.$disconnect() when the one-shot command ends. That is the lifecycle
  // of the connection pool, not a query on data.
  'jobs/syncArticles.ts',
]);

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

// An import (or require) of the Prisma package or of our singleton. `[^'"]*` covers
// any relative depth: '../lib/prisma', '../../lib/prisma'...
const PRISMA_IMPORT = /(?:from|require\()\s*['"](?:@prisma\/client|[^'"]*\/lib\/prisma)['"]/;

const importsPrisma = (relativePath: string): boolean =>
  PRISMA_IMPORT.test(fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf8'));

describe('Prisma access boundary', () => {
  const files = listSourceFiles(SRC_DIR);
  const filesImportingPrisma = files.filter(importsPrisma);

  it('finds the source files and detects Prisma imports (otherwise this guard proves nothing)', () => {
    expect(files).toContain('services/quizService.ts');
    // The repositories DO import Prisma: if none is detected, the regex is broken.
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
