# CLAUDE.md — rules for working on vocabio-backend with Claude Code

Claude Code reads this file automatically at the start of every session.
It is versioned: it acts as a contract between the developer and the AI, and as
documentation for anyone reviewing the project.

## The project in short

1:1 messaging backend for the Vocabio mobile app.
Express + Socket.io (same HTTP server), Prisma on Supabase PostgreSQL,
Supabase JWT auth verified locally via JWKS. Deployed on Railway.
Functional details: `README.md`. Historical implementation plan: `PLAN.md`.

## Architecture and conventions (must be followed)

- **routes → services → prisma**:
  - `src/routes/*`: HTTP only (reading `req`, input validation, status codes).
    No direct Prisma query inside a route.
  - `src/services/*`: all business logic and database access.
  - `src/sockets/handlers.ts`: calls the **same** services as the routes.
    Core rule: `messageService.createMessage` is the single path for creating
    a message (REST and Socket); it persists, then emits `new_message`.
- **Errors**: a service throws an `Error` with a `statusCode` field (see
  `assertParticipant` in `conversationService.ts`). Routes catch it and
  delegate to `handleError(res, error, 'METHOD /route')` (`src/utils/errors.ts`).
  Never send the message of a 500 error back to the client.
- **Validation**: done manually in routes for now (no zod).
  Introducing a validation library is a feature of its own, on its own branch.
- **Security**: every route/event touching a conversation calls
  `assertParticipant` before acting. Every route goes through `authMiddleware`.
- **Singletons**: Prisma via `src/lib/prisma.ts`, Socket.io via `getIO()` from `src/lib/socket.ts`.
- **Prisma migrations**: never modify a migration that has already been applied
  (`prisma/migrations/*`). Always create a new migration.
- **Style**: strict TypeScript. Existing code comments are in French; match the
  language of the file you are editing.
  The developer is learning: **comment the "why" generously**
  (choices, rejected alternatives, pitfalls), not just the "what".

## Commands

Node is installed via nvm (the active version must be loaded in the shell).

```bash
npm install              # dependencies
npx prisma generate      # regenerate the Prisma client after a schema.prisma change
npx tsc --noEmit         # type-check without producing a build
npm test                 # run jest (tests/**/*.test.ts)
npm run dev              # local server with hot reload (tsx watch)
npm run build            # compile to dist/
```

## Git workflow (mandatory)

1. **One branch per feature/fix**, created from an up-to-date `main`:
   `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>`, `test/<topic>`.
   Ask the developer for confirmation before creating the branch.
2. **Never commit or push to `main`.** Never `push --force`.
   Everything reaches `main` through a Pull Request reviewed and merged by the developer.
3. Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`),
   small and cohesive, with the `Co-Authored-By` trailer when Claude contributed
   (a transparency trail for AI usage).
4. Never commit secrets or `.claude/settings.local.json`.

## Feature process

1. **Plan**: for any non-trivial task, write/update a plan
   (plan mode or a section in `PLAN.md`) and get it approved before coding.
2. **Implementation** on the dedicated branch.
3. **Tests are mandatory**: any new logic in a service, route or Socket handler
   has its test in `tests/` (same tree as `src/`).
   `tsc --noEmit` and `jest` must pass before proposing a commit.
4. **AI review**: `/code-review` then `/security-review` on the branch.
5. **Docs**: update `README.md` whenever the REST API, Socket events,
   data model or configuration (env variables) change.
6. **PR** to `main`, reviewed line by line by the developer before merging.

## Tests: what we expect

- Services are tested with Prisma mocked (`jest.mock('../../src/lib/prisma')`),
  routes with `supertest` and the auth middleware mocked.
- A test must check a **behavior** (HTTP status, returned data, `emit` called
  with the right arguments, error thrown), not just "the mocked function was
  called". A test that would still pass with a wrong implementation is useless:
  flag it instead of writing it.
- Everything is mocked today: there is no integration test against a real
  database yet. Do not claim otherwise.

## Secrets

- Never read `.env` / `.env.local` (blocked in `.claude/settings.json`).
  The expected variable names are listed in `.env.example`.
- Never display, log or commit a token, a key or a database URL.
