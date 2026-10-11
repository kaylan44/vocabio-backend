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
  // The Prisma error this one was built from. It is there for the server logs only:
  // when this error is not handled by a service and ends as a 500, Node prints the
  // cause under it, with the constraint that broke and the original stack. Without
  // it, the log would only say "Unique constraint violated", with no table or column.
  //
  // It never reaches a client: handleError() sends a generic message for a 500 and
  // never serializes the error object.
  //
  // Why the property is declared here: `cause` is standard since ES2022, but
  // tsconfig.json targets the ES2020 library, whose Error type does not have it yet.
  // Declaring it keeps the compiler configuration untouched. Rejected alternative:
  // `super(message, { cause })`, which needs "lib": ["ES2022"].
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    // Fixed message on purpose: the Prisma message names tables and columns, and a
    // message is what a careless caller could one day send back to a client.
    super('Unique constraint violated');
    this.name = 'UniqueConstraintError';
    this.cause = cause;
  }
}

/**
 * Turns a Prisma error into a repository error when a service has a use for it, and
 * returns any other error as it is (the SAME object, so nothing is lost for the logs).
 * A translated error keeps the Prisma error as its `cause`, for the same reason.
 *
 * Usage, in a repository only:
 *   try { ... } catch (error) { throw toRepositoryError(error); }
 */
export const toRepositoryError = (error: unknown): unknown => {
  // P2002 = unique constraint violation.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new UniqueConstraintError(error);
  }
  return error;
};
