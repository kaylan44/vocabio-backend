// Tests unitaires du middleware d'authentification JWT.
//
// Stratégie de test :
// On ne veut pas faire de vrais appels réseau à Supabase JWKS ni toucher
// à une vraie base de données. On mocke donc :
//   - jsonwebtoken : pour simuler un JWT valide ou invalide sans avoir de vraie clé
//   - jwks-rsa     : pour éviter l'appel réseau à l'endpoint JWKS
//   - src/lib/prisma : pour éviter d'avoir une vraie base de données
//
// jest.mock() remplace le module par une version factice AVANT l'import.
// C'est pourquoi les jest.mock() sont au tout début du fichier.

import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../src/middleware/auth';

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

// Mock de jsonwebtoken : on contrôle ce que jwt.verify retourne
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

// Mock de jwks-rsa : le vrai module fait un appel réseau, on l'évite
jest.mock('jwks-rsa', () => {
  return jest.fn().mockReturnValue({
    getSigningKey: jest.fn((_kid: string, cb: Function) => {
      cb(null, { getPublicKey: () => 'fake-public-key' });
    }),
  });
});

// Mock de Prisma : on évite toute connexion à la base de données
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: {
      upsert: jest.fn().mockResolvedValue({
        id: 'user-123',
        username: 'testuser',
        avatarUrl: null,
        createdAt: new Date(),
      }),
    },
  },
}));

// Import après les mocks pour que Jest utilise les versions mockées
import jwt from 'jsonwebtoken';
import { prisma } from '../../src/lib/prisma';

// ─────────────────────────────────────────────
// Helpers : créer des objets Request/Response/Next factices
// ─────────────────────────────────────────────
const mockRequest = (headers: Record<string, string> = {}): Partial<Request> => ({
  headers,
});

const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {};
  // On enchaîne status().json() → les deux doivent retourner le même objet
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockNext: NextFunction = jest.fn();

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────
describe('authMiddleware', () => {
  // Payload JWT Supabase simulé
  const fakePayload = {
    sub: 'user-123',
    email: 'test@example.com',
    user_metadata: { full_name: 'Test User', avatar_url: 'https://example.com/avatar.jpg' },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────
  it('retourne 401 si le header Authorization est absent', () => {
    const req = mockRequest(); // Aucun header
    const res = mockResponse();

    authMiddleware(req as Request, res as Response, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token manquant ou mal formaté' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  it('retourne 401 si le header ne commence pas par "Bearer "', () => {
    const req = mockRequest({ authorization: 'Basic sometoken' });
    const res = mockResponse();

    authMiddleware(req as Request, res as Response, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  it('retourne 401 si jwt.verify retourne une erreur (token invalide)', (done) => {
    // Simule jwt.verify appelant le callback avec une erreur
    (jwt.verify as jest.Mock).mockImplementation((_token, _key, _opts, callback) => {
      callback(new Error('invalid signature'), null);
    });

    const req = mockRequest({ authorization: 'Bearer invalid.token.here' });
    const res = mockResponse();

    authMiddleware(req as Request, res as Response, mockNext);

    // jwt.verify est asynchrone → on attend que le callback soit appelé
    setImmediate(() => {
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token invalide ou expiré' });
      expect(mockNext).not.toHaveBeenCalled();
      done();
    });
  });

  // ─────────────────────────────────────────────
  it('appelle next() et attache req.user si le token est valide', (done) => {
    // Simule jwt.verify réussi → retourne le payload décodé
    (jwt.verify as jest.Mock).mockImplementation((_token, _key, _opts, callback) => {
      callback(null, fakePayload);
    });

    const req = mockRequest({ authorization: 'Bearer valid.token.here' });
    const res = mockResponse();

    authMiddleware(req as Request, res as Response, mockNext);

    setImmediate(async () => {
      // On attend que la promesse de l'upsert se resolv
      await Promise.resolve();

      expect(mockNext).toHaveBeenCalled();
      expect((req as any).user).toEqual({
        id: 'user-123',
        username: 'Test User',
        email: 'test@example.com',
      });
      done();
    });
  });

  // ─────────────────────────────────────────────
  it('fait un upsert Prisma avec les bonnes données', (done) => {
    (jwt.verify as jest.Mock).mockImplementation((_token, _key, _opts, callback) => {
      callback(null, fakePayload);
    });

    const req = mockRequest({ authorization: 'Bearer valid.token.here' });
    const res = mockResponse();

    authMiddleware(req as Request, res as Response, mockNext);

    setImmediate(async () => {
      await Promise.resolve();

      // Vérifie que l'upsert a bien été appelé avec les bonnes valeurs
      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        create: {
          id: 'user-123',
          username: 'Test User',
          avatarUrl: 'https://example.com/avatar.jpg',
        },
        update: {},
      });
      done();
    });
  });

  // ─────────────────────────────────────────────
  it('utilise le fallback email si user_metadata.full_name est absent', (done) => {
    const payloadSansNom = {
      ...fakePayload,
      user_metadata: {}, // Pas de full_name ni name
    };

    (jwt.verify as jest.Mock).mockImplementation((_token, _key, _opts, callback) => {
      callback(null, payloadSansNom);
    });

    const req = mockRequest({ authorization: 'Bearer valid.token.here' });
    const res = mockResponse();

    authMiddleware(req as Request, res as Response, mockNext);

    setImmediate(async () => {
      await Promise.resolve();

      // Le username doit être la partie locale de l'email (avant le @)
      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ username: 'test' }),
        })
      );
      done();
    });
  });
});
