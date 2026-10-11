// Tests unitaires du service utilisateurs.
//
// The repository is mocked: these tests check what the service decides (which limit,
// the trimmed text, no search at all for an empty query). The shape of the queries
// (exclusion of the connected user, sort, case-insensitive match) is checked in
// tests/repositories/userRepository.test.ts.

jest.mock('../../src/repositories/userRepository', () => ({
  findUsers: jest.fn(),
  searchUsersByUsername: jest.fn(),
  upsertUser: jest.fn(),
}));

import {
  ensureUser,
  LIST_USERS_LIMIT,
  listUsers,
  SEARCH_USERS_LIMIT,
  searchUsers,
} from '../../src/services/userService';
import {
  findUsers,
  searchUsersByUsername,
  upsertUser,
} from '../../src/repositories/userRepository';

const mockFindUsers = findUsers as jest.Mock;
const mockSearch = searchUsersByUsername as jest.Mock;
const mockUpsertUser = upsertUser as jest.Mock;

describe('userService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listUsers', () => {
    it('returns the other users, asked with the connected user excluded and the list limit', async () => {
      const fakeUsers = [{ id: 'user-2', username: 'Bob', avatarUrl: null }];
      mockFindUsers.mockResolvedValue(fakeUsers);

      const result = await listUsers('user-1');

      expect(result).toEqual(fakeUsers);
      expect(mockFindUsers).toHaveBeenCalledWith('user-1', LIST_USERS_LIMIT);
    });
  });

  describe('searchUsers', () => {
    it('retourne les utilisateurs dont le username correspond à la query', async () => {
      const fakeUsers = [
        { id: 'user-2', username: 'alice', avatarUrl: null },
      ];
      mockSearch.mockResolvedValue(fakeUsers);

      const result = await searchUsers('alice', 'user-1');

      expect(result).toEqual(fakeUsers);
      // The connected user is excluded from their own results, and the search is bounded.
      expect(mockSearch).toHaveBeenCalledWith('alice', 'user-1', SEARCH_USERS_LIMIT);
    });

    it('retourne un tableau vide si la query est vide', async () => {
      const result = await searchUsers('', 'user-1');
      expect(result).toEqual([]);
      // Aucun appel à la base ne doit être fait pour une query vide
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('retourne un tableau vide si la query ne contient que des espaces', async () => {
      const result = await searchUsers('   ', 'user-1');
      expect(result).toEqual([]);
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('trim la query avant de chercher', async () => {
      mockSearch.mockResolvedValue([]);
      await searchUsers('  bob  ', 'user-1');

      expect(mockSearch).toHaveBeenCalledWith('bob', 'user-1', SEARCH_USERS_LIMIT);
    });
  });

  describe('ensureUser', () => {
    const identity = { id: 'user-1', username: 'Alice', avatarUrl: null };

    it('stores exactly the identity it was given', async () => {
      mockUpsertUser.mockResolvedValue(undefined);

      await ensureUser(identity);

      expect(mockUpsertUser).toHaveBeenCalledWith(identity);
    });

    it('lets a database error reach the caller, so the request is refused instead of going on', async () => {
      // The auth middleware answers 500 and the Socket.io handshake refuses the
      // connection when this rejects: swallowing the error here would let a request
      // through for a user who has no row.
      mockUpsertUser.mockRejectedValue(new Error('db down'));

      await expect(ensureUser(identity)).rejects.toThrow('db down');
    });
  });
});
