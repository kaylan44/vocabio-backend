// Shared types: a conversation as the services handle it and as the client receives it.
// See src/types/user.ts for why such shapes live in src/types/.
//
// The `select` that must match these interfaces is CONVERSATION_SELECT in
// src/repositories/conversationRepository.ts.

import { PublicUser } from './user';

export interface ConversationParticipant {
  conversationId: string;
  userId: string;
  user: PublicUser;
}

export interface ConversationWithParticipants {
  id: string;
  createdAt: Date;
  participants: ConversationParticipant[];
}

// The latest message of a conversation, as shown in the list of chats. Fewer fields
// than MessageWithSender on purpose: the list needs no sender details.
export interface LastMessage {
  id: string;
  content: string;
  createdAt: Date;
  senderId: string;
  readAt: Date | null;
}

export interface ConversationWithLastMessage extends ConversationWithParticipants {
  // null when nobody has written in the conversation yet.
  lastMessage: LastMessage | null;
}
