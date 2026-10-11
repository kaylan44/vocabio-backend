// Unit tests of the message repository.
//
// Prisma is mocked: these tests check WHICH query is sent and what is handed back, not
// that the query is valid SQL. There is no test against a real database in this
// project yet.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    message: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../src/lib/prisma';
import {
  countUnreadMessages,
  createMessage,
  findMessages,
  markMessagesAsRead,
} from '../../src/repositories/messageRepository';

const mockCreate = prisma.message.create as jest.Mock;
const mockFindMany = prisma.message.findMany as jest.Mock;
const mockCount = prisma.message.count as jest.Mock;
const mockUpdateMany = prisma.message.updateMany as jest.Mock;

const message = {
  id: 'msg-1',
  conversationId: 'conv-1',
  senderId: 'user-1',
  content: 'Bonjour !',
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  readAt: null,
  sender: { id: 'user-1', username: 'Alice', avatarUrl: null },
};

// Everything a message query may return, with only the public fields of the sender.
// Adding a field here is a decision to expose it to the client: this list is also what
// goes out in the `new_message` event.
const MESSAGE_FIELDS = {
  id: true,
  conversationId: true,
  senderId: true,
  content: true,
  createdAt: true,
  readAt: true,
  sender: { select: { id: true, username: true, avatarUrl: true } },
};

describe('messageRepository', () => {
  beforeEach(() => jest.resetAllMocks());

  // ─────────────────────────────────────────────
  describe('createMessage', () => {
    it('stores the message unread and returns an explicit list of fields', async () => {
      mockCreate.mockResolvedValue(message);

      const created = await createMessage('conv-1', 'user-1', 'Bonjour !');

      expect(mockCreate).toHaveBeenCalledWith({
        // No readAt: a new message is unread until the recipient opens the conversation.
        data: { conversationId: 'conv-1', senderId: 'user-1', content: 'Bonjour !' },
        // `select`, never `include`: `include` would return every column of Message.
        select: MESSAGE_FIELDS,
      });
      expect(created).toEqual(message);
    });
  });

  // ─────────────────────────────────────────────
  describe('findMessages', () => {
    it('returns one page of the given conversation, newest first', async () => {
      mockFindMany.mockResolvedValue([message]);

      const page = await findMessages('conv-1', 30, 15);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1' },
        orderBy: { createdAt: 'desc' },
        skip: 30,
        take: 15,
        // `select`, never `include`: `include` would return every column of Message.
        select: MESSAGE_FIELDS,
      });
      expect(page).toEqual([message]);
    });
  });

  // ─────────────────────────────────────────────
  describe('countUnreadMessages', () => {
    it('counts the unread messages RECEIVED by the user in the conversation', async () => {
      mockCount.mockResolvedValue(2);

      const count = await countUnreadMessages('conv-1', 'user-1');

      expect(count).toBe(2);
      expect(mockCount).toHaveBeenCalledWith({
        where: {
          conversationId: 'conv-1',
          // Without this, the user's own messages would show up in their unread badge.
          senderId: { not: 'user-1' },
          readAt: null,
        },
      });
    });
  });

  // ─────────────────────────────────────────────
  describe('markMessagesAsRead', () => {
    it('marks only the unread messages received by the user, with the given date', async () => {
      const readAt = new Date('2026-10-02T10:00:00.000Z');
      mockUpdateMany.mockResolvedValue({ count: 3 });

      const count = await markMessagesAsRead('conv-1', 'user-1', readAt);

      expect(count).toBe(3);
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          conversationId: 'conv-1',
          senderId: { not: 'user-1' },
          // Without this, messages read earlier would get a new, later readAt.
          readAt: null,
        },
        data: { readAt },
      });
    });
  });
});
