// Tests d'intégration des routes /conversations.
//
// Stratégie :
// - supertest : simule des vraies requêtes HTTP sans démarrer le serveur sur un port
// - On mocke le middleware auth pour court-circuiter la vérification JWT
//   et injecter directement un req.user fictif
// - On mocke les services pour isoler les routes de la base de données
//
// Pourquoi mocker le middleware auth ?
// Sans mock, chaque requête devrait avoir un vrai JWT Supabase valide.
// En mockant, on teste uniquement le comportement de la route (validation du body,
// appel du bon service, code HTTP retourné) sans dépendance externe.

// ─────────────────────────────────────────────
// Mocks — doivent être déclarés AVANT les imports
// ─────────────────────────────────────────────

// Mock du middleware auth : on remplace authMiddleware par une fonction qui
// injecte directement un utilisateur fictif et appelle next()
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', username: 'Alice', email: 'alice@example.com' };
    next();
  },
}));

jest.mock('../../src/services/conversationService', () => ({
  getOrCreateConversation: jest.fn(),
  getUserConversations: jest.fn(),
  // assertParticipant N'EST PAS mocké ici car conversations.ts ne l'importe pas.
  // (C'est messages.ts qui l'utilise — voir messages.test.ts)
}));

// Socket.io : pas besoin d'un vrai serveur pour les tests REST
jest.mock('../../src/lib/socket', () => ({
  initSocket: jest.fn(),
  getIO: jest.fn().mockReturnValue({
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  }),
}));

import request from 'supertest';
import express from 'express';
import conversationRouter from '../../src/routes/conversations';
import { getOrCreateConversation, getUserConversations } from '../../src/services/conversationService';

const mockGetOrCreate = getOrCreateConversation as jest.Mock;
const mockGetUserConversations = getUserConversations as jest.Mock;

// Crée une mini app Express avec seulement le router à tester
// Pas besoin de démarrer tout app.ts (webhook, socket, etc.)
const app = express();
app.use(express.json());
app.use('/conversations', conversationRouter);

// ─────────────────────────────────────────────
// Données de test
// ─────────────────────────────────────────────
const fakeConversation = {
  id: 'conv-1',
  createdAt: new Date().toISOString(),
  participants: [
    { userId: 'user-1', user: { id: 'user-1', username: 'Alice', avatarUrl: null } },
    { userId: 'user-2', user: { id: 'user-2', username: 'Bob', avatarUrl: null } },
  ],
};

const fakeConversationList = [
  {
    id: 'conv-1',
    createdAt: new Date().toISOString(),
    otherParticipant: { id: 'user-2', username: 'Bob', avatarUrl: null },
    lastMessage: { id: 'msg-1', content: 'Salut !', createdAt: new Date().toISOString(), senderId: 'user-2' },
    unreadCount: 2,
  },
];

describe('Routes /conversations', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('POST /conversations', () => {
    it('retourne 200 et la conversation si recipientId est fourni', async () => {
      mockGetOrCreate.mockResolvedValue(fakeConversation);

      const res = await request(app)
        .post('/conversations')
        .send({ recipientId: 'user-2' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('conv-1');
      expect(mockGetOrCreate).toHaveBeenCalledWith('user-1', 'user-2');
    });

    it('retourne 400 si recipientId est absent du body', async () => {
      const res = await request(app)
        .post('/conversations')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(mockGetOrCreate).not.toHaveBeenCalled();
    });

    it('retourne 400 si l\'utilisateur essaie de créer une conversation avec lui-même', async () => {
      const res = await request(app)
        .post('/conversations')
        .send({ recipientId: 'user-1' }); // même ID que req.user.id mocké

      expect(res.status).toBe(400);
      expect(mockGetOrCreate).not.toHaveBeenCalled();
    });

    it('retourne 500 si le service lance une erreur inattendue', async () => {
      mockGetOrCreate.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/conversations')
        .send({ recipientId: 'user-2' });

      expect(res.status).toBe(500);
    });
  });

  // ─────────────────────────────────────────────
  describe('GET /conversations', () => {
    it('retourne 200 et la liste des conversations', async () => {
      mockGetUserConversations.mockResolvedValue(fakeConversationList);

      const res = await request(app).get('/conversations');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].otherParticipant.username).toBe('Bob');
      expect(res.body[0].unreadCount).toBe(2);
      expect(mockGetUserConversations).toHaveBeenCalledWith('user-1');
    });

    it('retourne 200 avec un tableau vide si aucune conversation', async () => {
      mockGetUserConversations.mockResolvedValue([]);

      const res = await request(app).get('/conversations');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('retourne 500 si le service lance une erreur', async () => {
      mockGetUserConversations.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/conversations');

      expect(res.status).toBe(500);
    });
  });
});
