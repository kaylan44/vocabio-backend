// Tests d'intégration des routes /conversations/:id/messages et /conversations/:id/read.
//
// Même stratégie que conversations.test.ts :
// - supertest pour les requêtes HTTP
// - middleware auth mocké pour injecter req.user
// - services mockés pour isoler de la base de données

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', username: 'Alice', email: 'alice@example.com' };
    next();
  },
}));

jest.mock('../../src/services/conversationService', () => ({
  assertParticipant: jest.fn(),
  getOrCreateConversation: jest.fn(),
  getUserConversations: jest.fn(),
}));

jest.mock('../../src/services/messageService', () => ({
  createMessage: jest.fn(),
  getMessages: jest.fn(),
  markConversationAsRead: jest.fn(),
}));

jest.mock('../../src/lib/socket', () => ({
  initSocket: jest.fn(),
  getIO: jest.fn().mockReturnValue({
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  }),
}));

import request from 'supertest';
import express from 'express';
import messageRouter from '../../src/routes/messages';
import { assertParticipant } from '../../src/services/conversationService';
import { createMessage, getMessages, markConversationAsRead } from '../../src/services/messageService';

const mockAssert = assertParticipant as jest.Mock;
const mockCreateMessage = createMessage as jest.Mock;
const mockGetMessages = getMessages as jest.Mock;
const mockMarkRead = markConversationAsRead as jest.Mock;

const app = express();
app.use(express.json());
// Le router messages est monté sous /conversations dans app.ts
// On le monte pareil ici pour que les params :id soient correctement parsés
app.use('/conversations', messageRouter);

// ─────────────────────────────────────────────
// Données de test
// ─────────────────────────────────────────────
const fakeMessage = {
  id: 'msg-1',
  conversationId: 'conv-1',
  senderId: 'user-1',
  content: 'Bonjour !',
  createdAt: new Date().toISOString(),
  readAt: null,
  sender: { id: 'user-1', username: 'Alice', avatarUrl: null },
};

describe('Routes /conversations/:id/messages', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('GET /conversations/:id/messages', () => {
    it('retourne 200 et les messages avec les infos de pagination', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockGetMessages.mockResolvedValue([fakeMessage]);

      const res = await request(app)
        .get('/conversations/conv-1/messages');

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].content).toBe('Bonjour !');
      // La réponse inclut les infos de pagination
      expect(res.body.pagination).toEqual({ offset: 0, limit: 30, count: 1 });
    });

    it('transmet les paramètres de pagination à getMessages', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockGetMessages.mockResolvedValue([]);

      await request(app)
        .get('/conversations/conv-1/messages?offset=10&limit=20');

      expect(mockGetMessages).toHaveBeenCalledWith('conv-1', 10, 20);
    });

    it('utilise offset=0 et limit=30 par défaut si absents', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockGetMessages.mockResolvedValue([]);

      await request(app).get('/conversations/conv-1/messages');

      expect(mockGetMessages).toHaveBeenCalledWith('conv-1', 0, 30);
    });

    it('retourne 403 si l\'utilisateur n\'est pas participant', async () => {
      // assertParticipant throw avec statusCode 403
      const err = new Error('Accès refusé') as any;
      err.statusCode = 403;
      mockAssert.mockRejectedValue(err);

      const res = await request(app)
        .get('/conversations/conv-1/messages');

      expect(res.status).toBe(403);
      expect(mockGetMessages).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  describe('POST /conversations/:id/messages', () => {
    it('retourne 201 et le message créé', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockCreateMessage.mockResolvedValue(fakeMessage);

      const res = await request(app)
        .post('/conversations/conv-1/messages')
        .send({ content: 'Bonjour !' });

      expect(res.status).toBe(201);
      expect(res.body.content).toBe('Bonjour !');
      expect(mockCreateMessage).toHaveBeenCalledWith('conv-1', 'user-1', 'Bonjour !');
    });

    it('trim le contenu avant de créer le message', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockCreateMessage.mockResolvedValue(fakeMessage);

      await request(app)
        .post('/conversations/conv-1/messages')
        .send({ content: '  Bonjour !  ' });

      expect(mockCreateMessage).toHaveBeenCalledWith('conv-1', 'user-1', 'Bonjour !');
    });

    it('retourne 400 si le contenu est vide', async () => {
      const res = await request(app)
        .post('/conversations/conv-1/messages')
        .send({ content: '   ' });

      expect(res.status).toBe(400);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('retourne 400 si le champ content est absent', async () => {
      const res = await request(app)
        .post('/conversations/conv-1/messages')
        .send({});

      expect(res.status).toBe(400);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('retourne 403 si l\'utilisateur n\'est pas participant', async () => {
      const err = new Error('Accès refusé') as any;
      err.statusCode = 403;
      mockAssert.mockRejectedValue(err);

      const res = await request(app)
        .post('/conversations/conv-1/messages')
        .send({ content: 'Bonjour !' });

      expect(res.status).toBe(403);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  describe('PATCH /conversations/:id/read', () => {
    it('retourne 200 avec le nombre de messages marqués comme lus', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockMarkRead.mockResolvedValue(5);

      const res = await request(app)
        .patch('/conversations/conv-1/read');

      expect(res.status).toBe(200);
      expect(res.body.markedAsRead).toBe(5);
      expect(mockMarkRead).toHaveBeenCalledWith('conv-1', 'user-1');
    });

    it('retourne 200 avec markedAsRead: 0 si aucun message non lu', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockMarkRead.mockResolvedValue(0);

      const res = await request(app)
        .patch('/conversations/conv-1/read');

      expect(res.status).toBe(200);
      expect(res.body.markedAsRead).toBe(0);
    });

    it('retourne 403 si l\'utilisateur n\'est pas participant', async () => {
      const err = new Error('Accès refusé') as any;
      err.statusCode = 403;
      mockAssert.mockRejectedValue(err);

      const res = await request(app)
        .patch('/conversations/conv-1/read');

      expect(res.status).toBe(403);
      expect(mockMarkRead).not.toHaveBeenCalled();
    });
  });
});
