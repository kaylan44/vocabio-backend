// Unit tests of the conversation repository.
//
// Prisma is mocked: these tests check WHICH query is sent and how its result is
// reshaped, not that the query is valid SQL. There is no test against a real database
// in this project yet.

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    conversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    participant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../src/lib/prisma';
import {
  createConversation,
  findConversationBetween,
  findConversationsOf,
  findParticipantUserIds,
  isParticipant,
} from '../../src/repositories/conversationRepository';

const mockFindFirst = prisma.conversation.findFirst as jest.Mock;
const mockCreate = prisma.conversation.create as jest.Mock;
const mockFindMany = prisma.conversation.findMany as jest.Mock;
const mockParticipantFindUnique = prisma.participant.findUnique as jest.Mock;
const mockParticipantFindMany = prisma.participant.findMany as jest.Mock;

const participants = [
  { conversationId: 'conv-1', userId: 'user-1', user: { id: 'user-1', username: 'Alice', avatarUrl: null } },
  { conversationId: 'conv-1', userId: 'user-2', user: { id: 'user-2', username: 'Bob', avatarUrl: null } },
];
const conversation = { id: 'conv-1', createdAt: new Date('2026-10-01T10:00:00.000Z'), participants };

// The only user fields that may be loaded with a participant.
const PUBLIC_USER_FIELDS = { id: true, username: true, avatarUrl: true };

// Everything a conversation query may return: adding a field here is a decision to
// expose it to the client.
const CONVERSATION_FIELDS = {
  id: true,
  createdAt: true,
  participants: {
    select: { conversationId: true, userId: true, user: { select: PUBLIC_USER_FIELDS } },
  },
};

describe('conversationRepository', () => {
  beforeEach(() => jest.resetAllMocks());

  // ─────────────────────────────────────────────
  describe('findConversationBetween', () => {
    it('requires BOTH users to be participants of the same conversation', async () => {
      mockFindFirst.mockResolvedValue(conversation);

      const found = await findConversationBetween('user-1', 'user-2');

      // Two separate `some`: one condition per user. A single `some` with both ids
      // would match a conversation containing only one of them.
      expect(mockFindFirst.mock.calls[0][0].where).toEqual({
        AND: [
          { participants: { some: { userId: 'user-1' } } },
          { participants: { some: { userId: 'user-2' } } },
        ],
      });
      expect(found).toEqual(conversation);
    });

    it('selects an explicit list of fields, with only the public fields of each participant', async () => {
      mockFindFirst.mockResolvedValue(null);

      await findConversationBetween('user-1', 'user-2');

      const query = mockFindFirst.mock.calls[0][0];
      // `include` would return every column of the tables, present and future.
      expect(query).not.toHaveProperty('include');
      expect(query.select).toEqual(CONVERSATION_FIELDS);
    });
  });

  // ─────────────────────────────────────────────
  describe('createConversation', () => {
    it('creates the conversation and its two participants in one nested create', async () => {
      mockCreate.mockResolvedValue(conversation);

      const created = await createConversation('user-1', 'user-2');

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0].data).toEqual({
        participants: { create: [{ userId: 'user-1' }, { userId: 'user-2' }] },
      });
      // Same explicit fields as a conversation that already existed.
      expect(mockCreate.mock.calls[0][0].select).toEqual(CONVERSATION_FIELDS);
      expect(created).toEqual(conversation);
    });
  });

  // ─────────────────────────────────────────────
  describe('findConversationsOf', () => {
    it('returns only the conversations the user takes part in', async () => {
      mockFindMany.mockResolvedValue([]);

      await findConversationsOf('user-1');

      expect(mockFindMany.mock.calls[0][0].where).toEqual({
        participants: { some: { userId: 'user-1' } },
      });
    });

    it('asks for the single most recent message of each conversation', async () => {
      mockFindMany.mockResolvedValue([]);

      await findConversationsOf('user-1');

      const { messages } = mockFindMany.mock.calls[0][0].select;
      expect(messages.orderBy).toEqual({ createdAt: 'desc' });
      expect(messages.take).toBe(1);
    });

    it('selects an explicit list of fields for the conversation and for its last message', async () => {
      mockFindMany.mockResolvedValue([]);

      await findConversationsOf('user-1');

      const query = mockFindMany.mock.calls[0][0];
      expect(query).not.toHaveProperty('include');
      const { messages, ...conversationFields } = query.select;
      expect(conversationFields).toEqual(CONVERSATION_FIELDS);
      expect(messages.select).toEqual({
        id: true,
        content: true,
        createdAt: true,
        senderId: true,
        readAt: true,
      });
    });

    it('exposes that message as lastMessage, and null when there is none', async () => {
      const message = {
        id: 'msg-1',
        content: 'Salut !',
        createdAt: new Date('2026-10-02T10:00:00.000Z'),
        senderId: 'user-2',
        readAt: null,
      };
      mockFindMany.mockResolvedValue([
        { ...conversation, messages: [message] },
        { ...conversation, id: 'conv-2', messages: [] },
      ]);

      const rows = await findConversationsOf('user-1');

      expect(rows[0].lastMessage).toEqual(message);
      expect(rows[1].lastMessage).toBeNull();
      // The Prisma detail (an array of at most one message) must not leak.
      expect(rows[0]).not.toHaveProperty('messages');
    });
  });

  // ─────────────────────────────────────────────
  describe('isParticipant', () => {
    it('is true when the (conversation, user) row exists', async () => {
      mockParticipantFindUnique.mockResolvedValue({ conversationId: 'conv-1', userId: 'user-1' });

      await expect(isParticipant('conv-1', 'user-1')).resolves.toBe(true);
      // Both ids are part of the key: checking the conversation alone would let any
      // user in.
      expect(mockParticipantFindUnique.mock.calls[0][0].where).toEqual({
        conversationId_userId: { conversationId: 'conv-1', userId: 'user-1' },
      });
    });

    it('is false when there is no such row', async () => {
      mockParticipantFindUnique.mockResolvedValue(null);

      await expect(isParticipant('conv-1', 'user-99')).resolves.toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  describe('findParticipantUserIds', () => {
    it('returns the user ids of the given conversation only', async () => {
      mockParticipantFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

      const userIds = await findParticipantUserIds('conv-1');

      expect(mockParticipantFindMany.mock.calls[0][0].where).toEqual({ conversationId: 'conv-1' });
      expect(userIds).toEqual(['user-1', 'user-2']);
    });
  });
});
