// Tests unitaires du service messages.
//
// Point de complexité : createMessage() appelle getIO() pour émettre sur Socket.io.
// On mocke src/lib/socket pour contrôler ce comportement dans les tests.
//
// The repositories are mocked: these tests check what the service does around the
// database (what it stores, who it notifies, what it returns). The shape of the
// queries is checked in tests/repositories/messageRepository.test.ts and
// conversationRepository.test.ts.

jest.mock('../../src/repositories/messageRepository', () => ({
  createMessage: jest.fn(),
  findMessages: jest.fn(),
  markMessagesAsRead: jest.fn(),
}));

jest.mock('../../src/repositories/conversationRepository', () => ({
  findParticipantUserIds: jest.fn(),
}));

// Mock du singleton Socket.io
// On crée un faux objet "io" avec les méthodes chaînées : io.to().emit()
const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
const mockGetIO = jest.fn().mockReturnValue({ to: mockTo });

jest.mock('../../src/lib/socket', () => ({
  getIO: mockGetIO,
  userRoom: (userId: string) => `user:${userId}`,
}));

import { createMessage, getMessages, markConversationAsRead } from '../../src/services/messageService';
import * as messageRepository from '../../src/repositories/messageRepository';
import { findParticipantUserIds } from '../../src/repositories/conversationRepository';

const mockCreate = messageRepository.createMessage as jest.Mock;
const mockFindMessages = messageRepository.findMessages as jest.Mock;
const mockMarkAsRead = messageRepository.markMessagesAsRead as jest.Mock;
const mockParticipants = findParticipantUserIds as jest.Mock;

const expectedRooms = ['conv-1', 'user:user-1', 'user:user-2'];

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
  beforeEach(() => {
    jest.clearAllMocks();
    mockParticipants.mockResolvedValue(['user-1', 'user-2']);
  });

  // ─────────────────────────────────────────────
  describe('createMessage', () => {
    it('persiste le message en base de données', async () => {
      mockCreate.mockResolvedValue(fakeMessage);

      await createMessage('conv-1', 'user-1', 'Bonjour !');

      expect(mockCreate).toHaveBeenCalledWith('conv-1', 'user-1', 'Bonjour !');
    });

    it('émet new_message sur la room de la conversation et les rooms des participants', async () => {
      mockCreate.mockResolvedValue(fakeMessage);

      await createMessage('conv-1', 'user-1', 'Bonjour !');

      // The rooms notified are the ones of THIS conversation's participants.
      expect(mockParticipants).toHaveBeenCalledWith('conv-1');
      expect(mockTo).toHaveBeenCalledWith(expectedRooms);
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

    it('retourne le message même si la diffusion Socket.io échoue', async () => {
      mockCreate.mockResolvedValue(fakeMessage);
      mockParticipants.mockRejectedValue(new Error('DB indisponible'));
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await createMessage('conv-1', 'user-1', 'Bonjour !');

      expect(result).toEqual(fakeMessage);
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  describe('getMessages', () => {
    it('retourne les messages avec la pagination correcte', async () => {
      mockFindMessages.mockResolvedValue([fakeMessage]);

      const result = await getMessages('conv-1', 60, 15);

      expect(result).toEqual([fakeMessage]);
      expect(mockFindMessages).toHaveBeenCalledWith('conv-1', 60, 15);
    });

    it('utilise offset=0 et limit=30 par défaut', async () => {
      mockFindMessages.mockResolvedValue([]);
      await getMessages('conv-1');

      expect(mockFindMessages).toHaveBeenCalledWith('conv-1', 0, 30);
    });
  });

  // ─────────────────────────────────────────────
  describe('markConversationAsRead', () => {
    it('met à jour les messages non lus envoyés par l\'autre participant', async () => {
      mockMarkAsRead.mockResolvedValue(3);

      const count = await markConversationAsRead('conv-1', 'user-1');

      expect(count).toBe(3);
      // For this conversation and this reader; "received and unread only" is the
      // repository's filter, checked in messageRepository.test.ts.
      expect(mockMarkAsRead).toHaveBeenCalledWith('conv-1', 'user-1', expect.any(Date));
    });

    it('émet message_read via Socket.io si des messages ont été marqués', async () => {
      mockMarkAsRead.mockResolvedValue(2);

      await markConversationAsRead('conv-1', 'user-1');

      expect(mockTo).toHaveBeenCalledWith(expectedRooms);
      expect(mockEmit).toHaveBeenCalledWith('message_read', expect.objectContaining({
        conversationId: 'conv-1',
        readByUserId: 'user-1',
      }));
    });

    it('announces in message_read the very date that was stored', async () => {
      mockMarkAsRead.mockResolvedValue(2);

      await markConversationAsRead('conv-1', 'user-1');

      // Two different dates would make the sender's screen disagree with the database.
      const storedReadAt = mockMarkAsRead.mock.calls[0][2];
      expect(mockEmit.mock.calls[0][1].readAt).toBe(storedReadAt);
    });

    it('n\'émet pas Socket.io si aucun message n\'était non lu', async () => {
      mockMarkAsRead.mockResolvedValue(0);

      await markConversationAsRead('conv-1', 'user-1');

      // Aucune émission Socket.io si count === 0
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });
});
