// Field lists (`select`) shared by several repositories.
//
// Why this file exists: the public fields of a user are needed by three repositories
// (users, conversations for the participants, messages for the sender). The list used
// to live in userRepository.ts, so the two others imported one repository from
// another. That made userRepository a hub the others depended on for a constant,
// while using none of its queries, and opened the door to circular imports the day
// userRepository needs something from the conversations.
//
// The rule now: a repository imports a shared field list from HERE, never from
// another repository. This file imports nothing, so it can never be part of a cycle.
//
// Why not src/types/: a `select` is how Prisma is told which columns to read. It is
// a persistence detail, and src/types/ only holds the shapes the layers exchange.
// The two must stay aligned, which is why each list below names its type.
//
// Only lists used by SEVERAL repositories belong here. A list used by one repository
// (CONVERSATION_SELECT, MESSAGE_SELECT, SUMMARY_SELECT...) stays next to its queries.

// The fields of a user that may leave the database: exactly those of PublicUser
// (src/types/user.ts). Adding a field here exposes it everywhere a user is returned
// (search, participants of a conversation, sender of a message), so it is a decision
// to take, never a convenience.
export const PUBLIC_USER_SELECT = { id: true, username: true, avatarUrl: true } as const;
