// Tests unitaires du service utilisateurs.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: jest.fn(),
    },
  },
}));

import { searchUsers } from '../../src/services/userService';
import { prisma } from '../../src/lib/prisma';

const mockFindMany = prisma.user.findMany as jest.Mock;

describe('userService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('searchUsers', () => {
    it('retourne les utilisateurs dont le username correspond à la query', async () => {
      const fakeUsers = [
        { id: 'user-2', username: 'alice', avatarUrl: null },
      ];
      mockFindMany.mockResolvedValue(fakeUsers);

      const result = await searchUsers('alice', 'user-1');

      expect(result).toEqual(fakeUsers);
      // Vérifie que la recherche est bien insensible à la casse et partielle
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            username: { contains: 'alice', mode: 'insensitive' },
            NOT: { id: 'user-1' },
          }),
        })
      );
    });

    it('retourne un tableau vide si la query est vide', async () => {
      const result = await searchUsers('', 'user-1');
      expect(result).toEqual([]);
      // Aucun appel Prisma ne doit être fait pour une query vide
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('retourne un tableau vide si la query ne contient que des espaces', async () => {
      const result = await searchUsers('   ', 'user-1');
      expect(result).toEqual([]);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('trim la query avant de chercher', async () => {
      mockFindMany.mockResolvedValue([]);
      await searchUsers('  bob  ', 'user-1');

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            username: { contains: 'bob', mode: 'insensitive' },
          }),
        })
      );
    });
  });
});
