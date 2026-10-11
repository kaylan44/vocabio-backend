// Tests unitaires du service conversations.
//
// The repositories are mocked: these tests check what the service decides (reuse or
// create, who the "other participant" is, the order of the list, the 403). The shape
// of the queries is checked in tests/repositories/conversationRepository.test.ts and
// messageRepository.test.ts.

jest.mock('../../src/repositories/conversationRepository', () => ({
  findConversationBetween: jest.fn(),
  createConversation: jest.fn(),
  findConversationsOf: jest.fn(),
  isParticipant: jest.fn(),
}));

jest.mock('../../src/repositories/messageRepository', () => ({
  countUnreadMessages: jest.fn(),
}));

import {
  getOrCreateConversation,
  getUserConversations,
  assertParticipant,
} from '../../src/services/conversationService';
import {
  createConversation,
  findConversationBetween,
  findConversationsOf,
  isParticipant,
} from '../../src/repositories/conversationRepository';
import { countUnreadMessages } from '../../src/repositories/messageRepository';

const mockFindBetween = findConversationBetween as jest.Mock;
const mockCreate = createConversation as jest.Mock;
const mockFindConversationsOf = findConversationsOf as jest.Mock;
const mockIsParticipant = isParticipant as jest.Mock;
const mockCountUnread = countUnreadMessages as jest.Mock;

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
      mockFindBetween.mockResolvedValue(fakeConversation);

      const result = await getOrCreateConversation('user-1', 'user-2');

      expect(result).toEqual(fakeConversation);
      // Si la conversation existe, elle ne doit PAS être créée une seconde fois
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('crée une nouvelle conversation si elle n\'existe pas', async () => {
      mockFindBetween.mockResolvedValue(null); // Aucune conversation existante
      mockCreate.mockResolvedValue(fakeConversation);

      const result = await getOrCreateConversation('user-1', 'user-2');

      expect(result).toEqual(fakeConversation);
      // The conversation is looked up, then created, for the same two users.
      expect(mockFindBetween).toHaveBeenCalledWith('user-1', 'user-2');
      expect(mockCreate).toHaveBeenCalledWith('user-1', 'user-2');
    });

    it('appelle deux fois getOrCreate avec les mêmes params → ne crée qu\'une conversation', async () => {
      // Premier appel : pas de conversation existante → création
      mockFindBetween.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(fakeConversation);

      // Deuxième appel : la conversation existe maintenant
      mockFindBetween.mockResolvedValueOnce(fakeConversation);

      await getOrCreateConversation('user-1', 'user-2');
      await getOrCreateConversation('user-1', 'user-2');

      // La création n'a eu lieu qu'une seule fois
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────
  describe('getUserConversations', () => {
    it('enrichit chaque conversation avec le bon "autre participant" et le unreadCount', async () => {
      const fakeConvWithMessage = {
        ...fakeConversation,
        lastMessage: { id: 'msg-1', content: 'Salut !', createdAt: new Date(), senderId: 'user-2', readAt: null },
      };
      mockFindConversationsOf.mockResolvedValue([fakeConvWithMessage]);
      mockCountUnread.mockResolvedValue(2); // 2 messages non lus

      const result = await getUserConversations('user-1');

      expect(result).toHaveLength(1);
      // L'autre participant est user-2 (pas user-1)
      expect(result[0].otherParticipant?.id).toBe('user-2');
      expect(result[0].unreadCount).toBe(2);
      expect(result[0].lastMessage?.content).toBe('Salut !');
      // The unread messages counted are the ones of THIS user in THIS conversation.
      expect(mockCountUnread).toHaveBeenCalledWith('conv-1', 'user-1');
    });

    it('retourne un tableau vide si l\'utilisateur n\'a pas de conversations', async () => {
      mockFindConversationsOf.mockResolvedValue([]);
      const result = await getUserConversations('user-1');
      expect(result).toEqual([]);
    });

    it('sorts by latest message, most recent first, with empty conversations last', async () => {
      const message = (id: string, createdAt: string) => ({
        id,
        content: 'x',
        createdAt: new Date(createdAt),
        senderId: 'user-2',
        readAt: null,
      });
      // Deliberately returned in the wrong order: the repository does not sort.
      mockFindConversationsOf.mockResolvedValue([
        { ...fakeConversation, id: 'old', lastMessage: message('m-1', '2026-10-01T10:00:00.000Z') },
        { ...fakeConversation, id: 'empty', lastMessage: null },
        { ...fakeConversation, id: 'recent', lastMessage: message('m-2', '2026-10-03T10:00:00.000Z') },
      ]);
      mockCountUnread.mockResolvedValue(0);

      const result = await getUserConversations('user-1');

      expect(result.map((conversation) => conversation.id)).toEqual(['recent', 'old', 'empty']);
    });
  });

  // ─────────────────────────────────────────────
  describe('assertParticipant', () => {
    it('ne throw pas si l\'utilisateur est participant', async () => {
      mockIsParticipant.mockResolvedValue(true);

      // Aucune erreur ne doit être levée
      await expect(assertParticipant('conv-1', 'user-1')).resolves.toBeUndefined();
      // The check is made for this conversation AND this user, in that order.
      expect(mockIsParticipant).toHaveBeenCalledWith('conv-1', 'user-1');
    });

    it('throw une erreur 403 si l\'utilisateur n\'est pas participant', async () => {
      mockIsParticipant.mockResolvedValue(false); // Pas de ligne dans participants

      await expect(assertParticipant('conv-1', 'user-99')).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });
});
