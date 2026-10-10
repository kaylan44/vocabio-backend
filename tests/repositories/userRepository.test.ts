// Unit tests of the user repository.
//
// Prisma is mocked: these tests check WHICH query the repository sends (filters,
// selected fields, limits), not that the query is valid SQL. There is no test against a
// real database in this project yet.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

import {
  findUsers,
  searchUsersByUsername,
  upsertUser,
} from '../../src/repositories/userRepository';
import { prisma } from '../../src/lib/prisma';

const mockUpsert = prisma.user.upsert as jest.Mock;
const mockFindMany = prisma.user.findMany as jest.Mock;

// The only user fields that may leave the database through this repository.
const PUBLIC_USER_FIELDS = { id: true, username: true, avatarUrl: true };

describe('userRepository', () => {
  beforeEach(() => jest.resetAllMocks());

  describe('upsertUser', () => {
    it('creates the user from the given identity and never updates an existing row', async () => {
      mockUpsert.mockResolvedValue({});

      await upsertUser({ id: 'user-1', username: 'Alice', avatarUrl: null });

      expect(mockUpsert).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        create: { id: 'user-1', username: 'Alice', avatarUrl: null },
        // An empty update is the whole point: a username edited by hand must survive.
        update: {},
      });
    });

    it('lets a database error reach the caller', async () => {
      mockUpsert.mockRejectedValue(new Error('db down'));

      await expect(
        upsertUser({ id: 'user-1', username: 'Alice', avatarUrl: null })
      ).rejects.toThrow('db down');
    });
  });

  describe('findUsers', () => {
    it('excludes the given user, sorts by username and applies the limit', async () => {
      const users = [{ id: 'user-2', username: 'Bob', avatarUrl: null }];
      mockFindMany.mockResolvedValue(users);

      const result = await findUsers('user-1', 100);

      expect(result).toEqual(users);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { NOT: { id: 'user-1' } },
        select: PUBLIC_USER_FIELDS,
        orderBy: { username: 'asc' },
        take: 100,
      });
    });
  });

  describe('searchUsersByUsername', () => {
    it('searches a part of the username whatever the case, without the given user', async () => {
      const users = [{ id: 'user-2', username: 'Alice', avatarUrl: null }];
      mockFindMany.mockResolvedValue(users);

      const result = await searchUsersByUsername('ali', 'user-1', 20);

      expect(result).toEqual(users);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          // contains + insensitive = ILIKE '%ali%': "ali" must find "Alice".
          username: { contains: 'ali', mode: 'insensitive' },
          NOT: { id: 'user-1' },
        },
        select: PUBLIC_USER_FIELDS,
        take: 20,
      });
    });
  });
});
