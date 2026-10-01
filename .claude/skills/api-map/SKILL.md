---
name: api-map
description: Displays a map of every REST route and Socket.io event of the backend, with the service each one calls and whether it is protected by authMiddleware and assertParticipant. Use when the developer asks to see or list the API, the routes, the endpoints or the socket events, or wants to check that the README matches the code.
---

# Map the API

Goal: give the developer a **simple, visual** overview of what the backend
exposes, and make a missing security guard obvious at a glance. This is not a
full audit: no long explanation.

## Source of truth

- The code, never the docs: `src/app.ts` (where routers are mounted),
  `src/routes/*`, `src/sockets/index.ts` and `src/sockets/handlers.ts`.
- `README.md` is only read at the end, to compare it with the code.
- Never read `.env` / `.env.local` ("Secrets" rule in `CLAUDE.md`).

## Steps

1. Read `src/app.ts` and note the mount path of each router (`app.use`).
   A router can be mounted on a prefix shared with another one.
2. For each file in `src/routes/`, list every `router.<method>(...)` and build
   the full path (mount prefix + route path).
3. For `src/sockets/handlers.ts`, list every `socket.on(...)` event, and every
   event the server emits (`emit(...)`, including the ones emitted from
   `src/services/*`).
4. For each route and each client → server event, record:
   - **Auth**: yes if `authMiddleware` applies (per route or through
     `router.use`), or, for sockets, if the handshake middleware in
     `src/sockets/index.ts` covers it;
   - **Participant check**: yes if the handler calls `assertParticipant`
     before acting; "n/a" if the route does not touch a conversation;
   - **Service**: the service function(s) the handler calls;
   - **Test**: whether a matching file exists in `tests/`.
5. Display the result:
   - if an inline visual rendering tool is available in the session, render
     two tables (REST routes, Socket.io events);
   - otherwise, answer with two Markdown tables;
   - a missing guard must stand out: mark it with a clear "missing" label
     and a warning color, never with color alone.
6. Under the tables, at most 5 lines in English:
   - routes or events that touch a conversation without `assertParticipant`;
   - routes with no `authMiddleware` (say why when it is intended, e.g. a
     webhook verified by signature);
   - differences between the code and the tables in `README.md` (route in
     one but not the other, different path or payload);
   - nothing else. If there is nothing to report, say so in one line.

## Arguments

- No argument: the whole API.
- `rest` or `socket`: only that half.
- A path or event name (e.g. `/api-map /conversations`): only the matching
  entries.

## Do not

- Do not modify any file (read-only skill), including `README.md`: report
  the differences and let the developer decide.
- Do not start the server or call any endpoint.
