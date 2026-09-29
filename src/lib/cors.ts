// Origines autorisées pour les appels cross-origin (REST et Socket.io).
//
// Pourquoi c'est nécessaire ?
// L'app Vocabio tourne aussi sur le web (Expo web) : le navigateur envoie une
// requête preflight OPTIONS avant chaque appel avec un header Authorization.
// Sans en-têtes Access-Control-* dans la réponse, le navigateur bloque l'appel.
// Les clients natifs (iOS/Android) ne sont pas concernés par CORS.
//
// Configuration : variable CORS_ORIGINS, liste séparée par des virgules.
// ex: CORS_ORIGINS="http://localhost:8081,https://vocabio.vercel.app"
// Si elle est définie, elle REMPLACE la valeur par défaut (pas de fusion).

// Défaut = front de production, pour que la prod fonctionne sans configuration.
// Le dev local (http://localhost:8081) doit être ajouté via CORS_ORIGINS.
const DEFAULT_ORIGINS = ['https://vocabio.vercel.app'];

export const parseAllowedOrigins = (raw: string | undefined): string[] => {
  const origins = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : DEFAULT_ORIGINS;
};

export const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);
