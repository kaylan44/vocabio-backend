// Shared type: a user as the rest of the application, and the client, may see it.
//
// Why src/types/ and not the repository that produces it: this shape is used by
// several layers (userService, the conversation and message repositories, and in
// the end the REST responses). Defined in userRepository, it forced a service to
// import from a repository just to name a type. src/types/ depends on nothing, so
// every layer can import it without creating a dependency between layers.
//
// Rule used to sort the types (see also CLAUDE.md):
//   - a shape shared between layers or sent to the client lives in src/types/;
//   - a shape that only describes the result of ONE query, read by one service
//     (e.g. ModeTotals in quizRepository.ts), stays next to that query.

// Declared by hand rather than inferred from Prisma: a column added to the User
// table later stays private until someone lists it here AND in PUBLIC_USER_SELECT
// (src/repositories/selects.ts), the `select` that must match this interface.
export interface PublicUser {
  id: string;
  username: string;
  avatarUrl: string | null;
}
