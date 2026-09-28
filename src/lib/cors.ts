// Origines autorisées pour les appels cross-origin (REST et Socket.io).
//
// Pourquoi c'est nécessaire ?
// L'app Vocabio tourne aussi sur le web (Expo web) : le navigateur envoie une
// requête preflight OPTIONS avant chaque appel avec un header Authorization.
// Sans en-têtes Access-Control-* dans la réponse, le navigateur bloque l'appel.
// Les clients natifs (iOS/Android) ne sont pas concernés par CORS.
//
// Configuration : variable CORS_ORIGINS, liste séparée par des virgules.
// ex: CORS_ORIGINS="http://localhost:8081,https://vocabio.app"

const DEFAULT_ORIGINS = ['http://localhost:8081'];

export const parseAllowedOrigins = (raw: string | undefined): string[] => {
  const origins = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : DEFAULT_ORIGINS;
};

export const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);
