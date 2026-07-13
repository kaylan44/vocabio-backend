// Tests d'intégration de la route GET /users/search.

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', username: 'Alice', email: 'alice@example.com' };
    next();
  },
}));

jest.mock('../../src/services/userService', () => ({
  searchUsers: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import userRouter from '../../src/routes/users';
import { searchUsers } from '../../src/services/userService';

const mockSearchUsers = searchUsers as jest.Mock;

const app = express();
app.use(express.json());
app.use('/users', userRouter);

describe('Routes /users', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /users/search', () => {
    it('retourne 200 et les utilisateurs correspondants', async () => {
      const fakeUsers = [{ id: 'user-2', username: 'Bob', avatarUrl: null }];
      mockSearchUsers.mockResolvedValue(fakeUsers);

      const res = await request(app).get('/users/search?q=bob');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(fakeUsers);
      // Vérifie que l'utilisateur connecté est bien exclu de sa propre recherche
      expect(mockSearchUsers).toHaveBeenCalledWith('bob', 'user-1');
    });

    it('retourne 400 si le paramètre q est absent', async () => {
      const res = await request(app).get('/users/search');

      expect(res.status).toBe(400);
      expect(mockSearchUsers).not.toHaveBeenCalled();
    });

    it('retourne 200 avec un tableau vide si aucun résultat', async () => {
      mockSearchUsers.mockResolvedValue([]);

      const res = await request(app).get('/users/search?q=inconnu');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('retourne 500 si le service lance une erreur', async () => {
      mockSearchUsers.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/users/search?q=bob');

      expect(res.status).toBe(500);
    });
  });
});
