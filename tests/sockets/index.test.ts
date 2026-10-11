// Unit tests of the Socket.io authentication handshake (src/sockets/index.ts).
//
// Strategy: no real Socket.io server. A fake `io` records the middleware given to
// io.use(), and each test calls that middleware directly with a fake socket.
//
// Mocked:
//   - jsonwebtoken: to simulate a valid or an invalid JWT without a real key
//   - userService.ensureUser: the handshake must go through the service, it has no
//     database access of its own (everything is mocked, there is no real database here)
//   - sockets/handlers: not the subject of this file (see handlers.test.ts)

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

jest.mock('../../src/services/userService', () => ({
  ensureUser: jest.fn(),
}));

jest.mock('../../src/sockets/handlers', () => ({
  registerConversationHandlers: jest.fn(),
}));

import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { initSocketHandlers } from '../../src/sockets';
import { ensureUser } from '../../src/services/userService';

const mockVerify = jwt.verify as jest.Mock;
const mockEnsureUser = ensureUser as jest.Mock;

type Next = (err?: Error) => void;
type Middleware = (socket: any, next: Next) => void;

// Registers the handlers on a fake server and returns the auth middleware it received.
const getAuthMiddleware = (): Middleware => {
  const io = { use: jest.fn(), on: jest.fn() };
  initSocketHandlers(io as unknown as Server);
  return io.use.mock.calls[0][0];
};

const createSocket = (token?: string) => ({
  handshake: { auth: token === undefined ? {} : { token } },
  data: {} as Record<string, unknown>,
});

// Runs the middleware and resolves with whatever it passed to next(): undefined when
// the connection is accepted, an Error when it is refused. Waiting on next() itself
// (instead of a timer) keeps the tests exact: they finish when the middleware does.
const runMiddleware = (socket: ReturnType<typeof createSocket>) =>
  new Promise<Error | undefined>((resolve) => {
    getAuthMiddleware()(socket, (err) => resolve(err));
  });

const payload = {
  sub: 'user-123',
  email: 'test@example.com',
  user_metadata: { full_name: 'Test User', avatar_url: 'https://example.com/avatar.jpg' },
};

// Makes jwt.verify answer like a valid token carrying `decoded`.
const acceptToken = (decoded: object) =>
  mockVerify.mockImplementation((_token, _key, _options, callback) => callback(null, decoded));

describe('Socket.io auth handshake', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // The handshake logs database errors: keep the test output clean.
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses the connection when no token is sent, without verifying anything', async () => {
    const error = await runMiddleware(createSocket());

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('Token manquant');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockEnsureUser).not.toHaveBeenCalled();
  });

  it('refuses the connection when the token is invalid, without creating a user', async () => {
    mockVerify.mockImplementation((_token, _key, _options, callback) =>
      callback(new Error('invalid signature'), null)
    );
    const socket = createSocket('bad.token');

    const error = await runMiddleware(socket);

    expect(error?.message).toBe('Token invalide ou expiré');
    expect(mockEnsureUser).not.toHaveBeenCalled();
    expect(socket.data.user).toBeUndefined();
  });

  it('accepts a valid token: ensures the user exists and attaches it to the socket', async () => {
    acceptToken(payload);
    mockEnsureUser.mockResolvedValue(undefined);
    const socket = createSocket('valid.token');

    const error = await runMiddleware(socket);

    expect(error).toBeUndefined();
    expect(mockEnsureUser).toHaveBeenCalledWith({
      id: 'user-123',
      username: 'Test User',
      avatarUrl: 'https://example.com/avatar.jpg',
    });
    expect(socket.data.user).toEqual({
      id: 'user-123',
      username: 'Test User',
      email: 'test@example.com',
    });
  });

  it('falls back to the local part of the email when the token carries no name or avatar', async () => {
    acceptToken({ ...payload, user_metadata: {} });
    mockEnsureUser.mockResolvedValue(undefined);

    await runMiddleware(createSocket('valid.token'));

    expect(mockEnsureUser).toHaveBeenCalledWith({
      id: 'user-123',
      username: 'test',
      avatarUrl: null,
    });
  });

  it('refuses the connection with a generic error when the database fails', async () => {
    acceptToken(payload);
    mockEnsureUser.mockRejectedValue(new Error('connection refused at db.internal:5432'));
    const socket = createSocket('valid.token');

    const error = await runMiddleware(socket);

    // The client must not learn anything about the database from the message.
    expect(error?.message).toBe('Erreur serveur');
    expect(socket.data.user).toBeUndefined();
  });
});
