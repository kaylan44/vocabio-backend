// Errors thrown by the repositories.
//
// Why this file exists: Prisma reports a broken unique constraint with its own error
// class and a code ('P2002'). If a service tested for that code, the business layer
// would depend on Prisma again, which is exactly what the repositories are here to
// prevent. So a repository translates the Prisma error into one of the classes below,
// and a service only ever writes `error instanceof UniqueConstraintError`.
//
// Only the errors a service actually reacts to are translated. Everything else
// (connection lost, timeout...) goes through untouched and ends as a 500 in
// handleError(), which never sends its message to the client.

import { Prisma } from '@prisma/client';

/**
 * A row with the same unique key already exists (primary key or @@unique).
 *
 * It is not always a failure for the caller: when two identical requests race, the
 * loser gets this error and the data it wanted to store IS there.
 */
export class UniqueConstraintError extends Error {
  constructor() {
    // Fixed message on purpose: the Prisma message names tables and columns.
    super('Unique constraint violated');
    this.name = 'UniqueConstraintError';
  }
}

/**
 * Turns a Prisma error into a repository error when a service has a use for it, and
 * returns any other error as it is (the SAME object, so nothing is lost for the logs).
 *
 * Usage, in a repository only:
 *   try { ... } catch (error) { throw toRepositoryError(error); }
 */
export const toRepositoryError = (error: unknown): unknown => {
  // P2002 = unique constraint violation.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new UniqueConstraintError();
  }
  return error;
};
