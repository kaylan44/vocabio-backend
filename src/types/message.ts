// Shared type: a message with its sender.
//
// It is what the REST routes return and what the `new_message` Socket.io event
// carries, so it is part of the contract with the app. See src/types/user.ts for why
// such shapes live in src/types/.
//
// The `select` that must match this interface is MESSAGE_SELECT in
// src/repositories/messageRepository.ts.

import { PublicUser } from './user';

export interface MessageWithSender {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: Date;
  // null = not read yet by the recipient.
  readAt: Date | null;
  sender: PublicUser;
}
