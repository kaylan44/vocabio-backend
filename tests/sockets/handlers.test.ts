// Tests unitaires des handlers Socket.io.
//
// Stratégie de test :
// On ne démarre pas un vrai serveur Socket.io. On crée à la place des objets
// "socket" et "io" factices (mocks) qui imitent l'interface de Socket.io.
// Cela permet de tester la logique de chaque handler de façon isolée et rapide.
//
// Pour tester un handler :
//   1. On appelle registerConversationHandlers(mockIo, mockSocket)
//   2. On récupère le callback enregistré via mockSocket.on (ex: pour 'send_message')
//   3. On appelle ce callback directement avec un payload de test
//   4. On vérifie les effets (appel de service, émission d'événement)

jest.mock('../../src/services/conversationService', () => ({
  assertParticipant: jest.fn(),
}));

jest.mock('../../src/services/messageService', () => ({
  createMessage: jest.fn(),
  markConversationAsRead: jest.fn(),
}));

import { registerConversationHandlers } from '../../src/sockets/handlers';
import { assertParticipant } from '../../src/services/conversationService';
import { createMessage, markConversationAsRead } from '../../src/services/messageService';

const mockAssert = assertParticipant as jest.Mock;
const mockCreateMessage = createMessage as jest.Mock;
const mockMarkRead = markConversationAsRead as jest.Mock;

// ─────────────────────────────────────────────
// Helpers : créer des objets socket/io factices
// ─────────────────────────────────────────────

// Crée un faux objet Socket qui :
// - stocke les handlers enregistrés via .on()
// - expose .emit() et .join() comme mocks Jest
const createMockSocket = (userId = 'user-1', username = 'Alice') => {
  const handlers: Record<string, Function> = {};
  return {
    data: { user: { id: userId, username } },
    on: jest.fn((event: string, handler: Function) => {
      handlers[event] = handler;
    }),
    emit: jest.fn(),
    join: jest.fn(),
    to: jest.fn().mockReturnThis(), // socket.to(room) retourne le socket lui-même
    _handlers: handlers,            // Exposé pour les tests : permet d'appeler les handlers
  };
};

// Crée un faux objet Server Socket.io
const createMockIO = () => ({
  to: jest.fn().mockReturnValue({ emit: jest.fn() }),
});

describe('registerConversationHandlers', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocket = createMockSocket();
    mockIO = createMockIO();
    // Enregistre les handlers sur le socket factice
    registerConversationHandlers(mockIO as any, mockSocket as any);
  });

  // ─────────────────────────────────────────────
  describe('join_conversation', () => {
    it('rejoint la room si l\'utilisateur est participant', async () => {
      mockAssert.mockResolvedValue(undefined); // assertParticipant réussit

      await mockSocket._handlers['join_conversation']({ conversationId: 'conv-1' });

      expect(mockAssert).toHaveBeenCalledWith('conv-1', 'user-1');
      expect(mockSocket.join).toHaveBeenCalledWith('conv-1');
    });

    it('émet une erreur si l\'utilisateur n\'est pas participant', async () => {
      mockAssert.mockRejectedValue(new Error('Accès refusé'));

      await mockSocket._handlers['join_conversation']({ conversationId: 'conv-1' });

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        message: expect.any(String),
      }));
    });
  });

  // ─────────────────────────────────────────────
  describe('send_message', () => {
    it('appelle createMessage avec les bons arguments', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockCreateMessage.mockResolvedValue({});

      await mockSocket._handlers['send_message']({
        conversationId: 'conv-1',
        content: 'Bonjour !',
      });

      expect(mockCreateMessage).toHaveBeenCalledWith('conv-1', 'user-1', 'Bonjour !');
    });

    it('trim le contenu avant de créer le message', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockCreateMessage.mockResolvedValue({});

      await mockSocket._handlers['send_message']({
        conversationId: 'conv-1',
        content: '  Bonjour !  ',
      });

      expect(mockCreateMessage).toHaveBeenCalledWith('conv-1', 'user-1', 'Bonjour !');
    });

    it('émet une erreur si le contenu est vide', async () => {
      await mockSocket._handlers['send_message']({
        conversationId: 'conv-1',
        content: '   ',
      });

      expect(mockCreateMessage).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        message: expect.any(String),
      }));
    });

    it('émet une erreur si l\'utilisateur n\'est pas participant', async () => {
      mockAssert.mockRejectedValue(new Error('Accès refusé'));

      await mockSocket._handlers['send_message']({
        conversationId: 'conv-1',
        content: 'Bonjour !',
      });

      expect(mockCreateMessage).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        message: expect.any(String),
      }));
    });
  });

  // ─────────────────────────────────────────────
  describe('mark_read', () => {
    it('appelle markConversationAsRead avec les bons arguments', async () => {
      mockAssert.mockResolvedValue(undefined);
      mockMarkRead.mockResolvedValue(3);

      await mockSocket._handlers['mark_read']({ conversationId: 'conv-1' });

      expect(mockMarkRead).toHaveBeenCalledWith('conv-1', 'user-1');
    });

    it('émet une erreur si l\'utilisateur n\'est pas participant', async () => {
      mockAssert.mockRejectedValue(new Error('Accès refusé'));

      await mockSocket._handlers['mark_read']({ conversationId: 'conv-1' });

      expect(mockMarkRead).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        message: expect.any(String),
      }));
    });
  });

  // ─────────────────────────────────────────────
  describe('typing', () => {
    it('rebroadcast user_typing aux autres membres de la room', async () => {
      mockAssert.mockResolvedValue(undefined);
      const mockEmit = jest.fn();
      mockSocket.to = jest.fn().mockReturnValue({ emit: mockEmit });

      await mockSocket._handlers['typing']({ conversationId: 'conv-1' });

      // socket.to('conv-1') cible tous sauf l'émetteur
      expect(mockSocket.to).toHaveBeenCalledWith('conv-1');
      expect(mockEmit).toHaveBeenCalledWith('user_typing', {
        conversationId: 'conv-1',
        userId: 'user-1',
        username: 'Alice',
      });
    });

    it('ignore silencieusement les erreurs (événement non critique)', async () => {
      mockAssert.mockRejectedValue(new Error('Accès refusé'));

      // Ne doit pas throw
      await expect(
        mockSocket._handlers['typing']({ conversationId: 'conv-1' })
      ).resolves.not.toThrow();
    });
  });
});
