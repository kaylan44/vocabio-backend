// Vérification des JWT Supabase — partagée par le middleware HTTP et le middleware Socket.io.
//
// Pourquoi ES256 ET RS256 ?
// Les projets Supabase récents signent leurs JWT avec une clé elliptique (ES256).
// N'accepter que RS256 rejetait donc TOUS les tokens (401 systématique).
// RS256 reste accepté pour ne pas casser si la clé de signature est remplacée par une RSA.
// HS256 (secret partagé) n'est volontairement pas accepté : la vérification passe par JWKS.

import jwt from 'jsonwebtoken';
import jwksRsa, { JwksClient } from 'jwks-rsa';

export const SUPABASE_JWT_ALGORITHMS: jwt.Algorithm[] = ['ES256', 'RS256'];

export interface SupabaseJwtPayload extends jwt.JwtPayload {
  sub: string;
  email: string;
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
  };
}

/**
 * Construit l'URL JWKS à partir de SUPABASE_URL.
 * On ne garde que l'origine : une valeur copiée depuis le dashboard avec un chemin
 * (ex: ".../rest/v1/") produisait une URL JWKS inexistante.
 */
export const jwksUriFrom = (supabaseUrl: string): string =>
  `${new URL(supabaseUrl).origin}/auth/v1/.well-known/jwks.json`;

/** Adapte un client JWKS au format "clé dynamique" attendu par jwt.verify. */
export const signingKeyResolver =
  (client: JwksClient) => (header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err || !key) return callback(err ?? new Error('Clé JWKS introuvable'));
      callback(null, key.getPublicKey());
    });
  };

// Client créé au premier usage : SUPABASE_URL peut être absente en test,
// et new URL('') lèverait une exception dès l'import du module.
let resolver: ReturnType<typeof signingKeyResolver> | undefined;

const getResolver = () => {
  if (!resolver) {
    const client = jwksRsa({
      jwksUri: jwksUriFrom(process.env.SUPABASE_URL ?? ''),
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
    });
    resolver = signingKeyResolver(client);
  }
  return resolver;
};

/**
 * Clé dynamique pour jwt.verify, à utiliser avec { algorithms: SUPABASE_JWT_ALGORITHMS }.
 * Le client JWKS (et son cache) est partagé entre HTTP et Socket.io.
 */
export const getSigningKey = (header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void => {
  try {
    getResolver()(header, callback);
  } catch (err) {
    // SUPABASE_URL absente ou invalide : échec explicite plutôt qu'un 401 inexpliqué
    console.error('[jwt] Configuration SUPABASE_URL invalide:', err);
    callback(err as Error);
  }
};
