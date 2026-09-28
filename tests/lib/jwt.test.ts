// Tests de la vérification JWT — sans mock de jsonwebtoken ni jwks-rsa.
// On génère une vraie paire de clés ES256 (même type que la clé Supabase du projet)
// et on sert son JWK via getKeysInterceptor pour éviter tout appel réseau.

import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { jwksUriFrom, signingKeyResolver, SUPABASE_JWT_ALGORITHMS } from '../../src/lib/jwt';

describe('jwksUriFrom', () => {
  it('construit l\'URL JWKS depuis l\'URL du projet', () => {
    expect(jwksUriFrom('https://abc.supabase.co')).toBe(
      'https://abc.supabase.co/auth/v1/.well-known/jwks.json'
    );
  });

  it('ignore un chemin copié par erreur (ex: /rest/v1/)', () => {
    expect(jwksUriFrom('https://abc.supabase.co/rest/v1/')).toBe(
      'https://abc.supabase.co/auth/v1/.well-known/jwks.json'
    );
  });
});

describe('vérification d\'un token ES256 via JWKS', () => {
  const KID = 'test-kid';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };

  const client = jwksRsa({
    jwksUri: 'https://unused.test/jwks.json',
    getKeysInterceptor: async () => [jwk as any],
  });
  const getKey = signingKeyResolver(client);

  const token = jwt.sign({ sub: 'user-1', email: 'a@b.test' }, privateKey, {
    algorithm: 'ES256',
    keyid: KID,
    expiresIn: '1h',
  });

  const verify = (algorithms: jwt.Algorithm[]) =>
    new Promise<jwt.JwtPayload>((resolve, reject) =>
      jwt.verify(token, getKey, { algorithms }, (err, decoded) =>
        err ? reject(err) : resolve(decoded as jwt.JwtPayload)
      )
    );

  it('accepte le token avec les algorithmes configurés', async () => {
    await expect(verify(SUPABASE_JWT_ALGORITHMS)).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('le rejetait avec RS256 seul (cause des 401)', async () => {
    await expect(verify(['RS256'])).rejects.toThrow(/invalid algorithm/);
  });
});
