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

import { upsertUser } from '../../src/repositories/userRepository';
import { prisma } from '../../src/lib/prisma';

const mockUpsert = prisma.user.upsert as jest.Mock;

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
});
