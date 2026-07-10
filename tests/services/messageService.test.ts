// Tests unitaires du service messages.
//
// Point de complexité : createMessage() appelle getIO() pour émettre sur Socket.io.
// On mocke src/lib/socket pour contrôler ce comportement dans les tests.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    message: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

// Mock du singleton Socket.io
// On crée un faux objet "io" avec les méthodes chaînées : io.to().emit()
const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
const mockGetIO = jest.fn().mockReturnValue({ to: mockTo });

jest.mock('../../src/lib/socket', () => ({
  getIO: mockGetIO,
}));

import { createMessage, getMessages, markConversationAsRead } from '../../src/services/messageService';
import { prisma } from '../../src/lib/prisma';

const mockCreate = prisma.message.create as jest.Mock;
const mockFindMany = prisma.message.findMany as jest.Mock;
const mockUpdateMany = prisma.message.updateMany as jest.Mock;

const fakeMessage = {
  id: 'msg-1',
  conversationId: 'conv-1',
  senderId: 'user-1',
  content: 'Bonjour !',
  createdAt: new Date(),
  readAt: null,
  sender: { id: 'user-1', username: 'Alice', avatarUrl: null },
};

describe('messageService', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  describe('createMessage', () => {
    it('persiste le message en base de données', async () => {
      mockCreate.mockResolvedValue(fakeMessage);

      await createMessage('conv-1', 'user-1', 'Bonjour !');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { conversationId: 'conv-1', senderId: 'user-1', content: 'Bonjour !' },
        })
      );
    });

    it('émet l\'événement new_message sur la room Socket.io de la conversation', async () => {
      mockCreate.mockResolvedValue(fakeMessage);

      await createMessage('conv-1', 'user-1', 'Bonjour !');

      // Vérifie que io.to('conv-1').emit('new_message', ...) a bien été appelé
      expect(mockTo).toHaveBeenCalledWith('conv-1');
      expect(mockEmit).toHaveBeenCalledWith('new_message', expect.objectContaining({
        id: 'msg-1',
        conversationId: 'conv-1',
        content: 'Bonjour !',
      }));
    });

    it('retourne le message créé', async () => {
      mockCreate.mockResolvedValue(fakeMessage);
      const result = await createMessage('conv-1', 'user-1', 'Bonjour !');
      expect(result).toEqual(fakeMessage);
    });
  });

  // ─────────────────────────────────────────────
  describe('getMessages', () => {
    it('retourne les messages avec la pagination correcte', async () => {
      mockFindMany.mockResolvedValue([fakeMessage]);

      const result = await getMessages('conv-1', 0, 30);

      expect(result).toEqual([fakeMessage]);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: 'conv-1' },
          skip: 0,
          take: 30,
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('utilise offset=0 et limit=30 par défaut', async () => {
      mockFindMany.mockResolvedValue([]);
      await getMessages('conv-1');

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 30 })
      );
    });
  });

  // ─────────────────────────────────────────────
  describe('markConversationAsRead', () => {
    it('met à jour les messages non lus envoyés par l\'autre participant', async () => {
      mockUpdateMany.mockResolvedValue({ count: 3 });

      const count = await markConversationAsRead('conv-1', 'user-1');

      expect(count).toBe(3);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            conversationId: 'conv-1',
            senderId: { not: 'user-1' }, // Seulement les messages reçus
            readAt: null,
          }),
        })
      );
    });

    it('émet message_read via Socket.io si des messages ont été marqués', async () => {
      mockUpdateMany.mockResolvedValue({ count: 2 });

      await markConversationAsRead('conv-1', 'user-1');

      expect(mockTo).toHaveBeenCalledWith('conv-1');
      expect(mockEmit).toHaveBeenCalledWith('message_read', expect.objectContaining({
        conversationId: 'conv-1',
        readByUserId: 'user-1',
      }));
    });

    it('n\'émet pas Socket.io si aucun message n\'était non lu', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await markConversationAsRead('conv-1', 'user-1');

      // Aucune émission Socket.io si count === 0
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });
});
