// User repository.
//
// A repository is the only kind of file allowed to talk to Prisma. It answers one
// question: "how do we read or write this in the database?". It never decides
// anything about the business (no status code, no permission check, no limit chosen
// here): those stay in src/services/.
//
// Why this extra layer: a service then reads as a list of business steps
// (`findUsers(...)`), and Prisma details (`where`, `select`, error codes) live in one
// place per table. Rejected alternative: classes with constructor injection. The
// services are already modules of functions mocked with jest.mock, so repositories
// follow the same shape.

import { prisma } from '../lib/prisma';

// What the rest of the application is allowed to know about a user. Declared by hand
// rather than inferred from Prisma: a column added to the table later stays private
// until someone lists it here.
export interface PublicUser {
  id: string;
  username: string;
  avatarUrl: string | null;
}

// Single definition of the fields selected for a PublicUser. Exported so that the
// other repositories load a user (a sender, a participant) with exactly these fields.
export const PUBLIC_USER_SELECT = { id: true, username: true, avatarUrl: true } as const;

/**
 * Creates the user if no row has this id, and does nothing otherwise.
 *
 * `update: {}` on purpose: existing data is never overwritten, so a username edited
 * by hand in the database survives the next login.
 */
export const upsertUser = async (user: PublicUser): Promise<void> => {
  await prisma.user.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
    },
    update: {},
  });
};

/**
 * Users in alphabetical order, without `excludeUserId`.
 *
 * @param limit - Maximum number of rows; the value is a business choice, made by the service
 */
export const findUsers = async (excludeUserId: string, limit: number): Promise<PublicUser[]> => {
  return prisma.user.findMany({
    where: { NOT: { id: excludeUserId } },
    select: PUBLIC_USER_SELECT,
    orderBy: { username: 'asc' },
    take: limit,
  });
};

/**
 * Users whose username contains `text`, whatever the case, without `excludeUserId`.
 * Prisma turns `contains` + `mode: 'insensitive'` into ILIKE '%text%' on PostgreSQL.
 */
export const searchUsersByUsername = async (
  text: string,
  excludeUserId: string,
  limit: number
): Promise<PublicUser[]> => {
  return prisma.user.findMany({
    where: {
      username: {
        contains: text,
        mode: 'insensitive',
      },
      NOT: { id: excludeUserId },
    },
    select: PUBLIC_USER_SELECT,
    take: limit,
  });
};
