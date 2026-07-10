// Tests unitaires du service conversations.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    conversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    participant: {
      findUnique: jest.fn(),
    },
    message: {
      count: jest.fn(),
    },
  },
}));

import {
  getOrCreateConversation,
  getUserConversations,
  assertParticipant,
} from '../../src/services/conversationService';
import { prisma } from '../../src/lib/prisma';

const mockFindFirst = prisma.conversation.findFirst as jest.Mock;
const mockCreate = prisma.conversation.create as jest.Mock;
const mockFindMany = prisma.conversation.findMany as jest.Mock;
const mockFindUnique = prisma.participant.findUnique as jest.Mock;
const mockCount = prisma.message.count as jest.Mock;

// Données de test réutilisables
const fakeConversation = {
  id: 'conv-1',
  createdAt: new Date(),
  participants: [
    { userId: 'user-1', user: { id: 'user-1', username: 'Alice', avatarUrl: null } },
    { userId: 'user-2', user: { id: 'user-2', username: 'Bob', avatarUrl: null } },
  ],
};

describe('conversationService', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('getOrCreateConversation', () => {
    it('retourne la conversation existante si elle existe (idempotent)', async () => {
      // Simule une conversation déjà en base
      mockFindFirst.mockResolvedValue(fakeConversation);

      const result = await getOrCreateConversation('user-1', 'user-2');

      expect(result).toEqual(fakeConversation);
      // Si la conversation existe, create() ne doit PAS être appelé
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('crée une nouvelle conversation si elle n\'existe pas', async () => {
      mockFindFirst.mockResolvedValue(null); // Aucune conversation existante
      mockCreate.mockResolvedValue(fakeConversation);

      const result = await getOrCreateConversation('user-1', 'user-2');

      expect(result).toEqual(fakeConversation);
      // create() doit être appelé avec les deux participants
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            participants: {
              create: [{ userId: 'user-1' }, { userId: 'user-2' }],
            },
          }),
        })
      );
    });

    it('appelle deux fois getOrCreate avec les mêmes params → ne crée qu\'une conversation', async () => {
      // Premier appel : pas de conversation existante → création
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(fakeConversation);

      // Deuxième appel : la conversation existe maintenant
      mockFindFirst.mockResolvedValueOnce(fakeConversation);

      await getOrCreateConversation('user-1', 'user-2');
      await getOrCreateConversation('user-1', 'user-2');

      // create() n'a été appelé qu'une seule fois
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────
  describe('getUserConversations', () => {
    it('enrichit chaque conversation avec le bon "autre participant" et le unreadCount', async () => {
      const fakeConvWithMessages = {
        ...fakeConversation,
        messages: [{ id: 'msg-1', content: 'Salut !', createdAt: new Date(), senderId: 'user-2', readAt: null }],
      };
      mockFindMany.mockResolvedValue([fakeConvWithMessages]);
      mockCount.mockResolvedValue(2); // 2 messages non lus

      const result = await getUserConversations('user-1');

      expect(result).toHaveLength(1);
      // L'autre participant est user-2 (pas user-1)
      expect(result[0].otherParticipant?.id).toBe('user-2');
      expect(result[0].unreadCount).toBe(2);
      expect(result[0].lastMessage?.content).toBe('Salut !');
    });

    it('retourne un tableau vide si l\'utilisateur n\'a pas de conversations', async () => {
      mockFindMany.mockResolvedValue([]);
      const result = await getUserConversations('user-1');
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  describe('assertParticipant', () => {
    it('ne throw pas si l\'utilisateur est participant', async () => {
      mockFindUnique.mockResolvedValue({ conversationId: 'conv-1', userId: 'user-1' });

      // Aucune erreur ne doit être levée
      await expect(assertParticipant('conv-1', 'user-1')).resolves.toBeUndefined();
    });

    it('throw une erreur 403 si l\'utilisateur n\'est pas participant', async () => {
      mockFindUnique.mockResolvedValue(null); // Pas de ligne dans participants

      await expect(assertParticipant('conv-1', 'user-99')).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });
});
