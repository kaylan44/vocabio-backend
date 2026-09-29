-- Active Row Level Security (RLS) sur toutes les tables du schéma public.
--
-- Pourquoi : Supabase expose automatiquement le schéma "public" via son Data API
-- (PostgREST, https://<projet>.supabase.co/rest/v1/...). La clé "anon" est publique
-- (embarquée dans l'app mobile) : sans RLS, n'importe qui pouvait donc lire, modifier
-- ou supprimer les lignes de "User", "Conversation", "Participant" et "Message"
-- directement, en contournant complètement ce backend et assertParticipant.
--
-- Choix : RLS activé SANS aucune policy = "tout refuser" pour les rôles anon et
-- authenticated (ceux utilisés par PostgREST). C'est voulu : le mobile ne doit
-- passer que par l'API Express, jamais par la base en direct.
-- Alternative rejetée : écrire des policies (ex. "un participant peut lire ses
-- messages"). Ça dupliquerait la logique de conversationService en SQL, avec deux
-- sources de vérité à maintenir, pour un accès direct dont on n'a pas besoin.
--
-- Pourquoi le backend n'est pas cassé : Prisma se connecte avec le rôle "postgres",
-- propriétaire des tables. En Postgres, le propriétaire d'une table ignore le RLS
-- (sauf FORCE ROW LEVEL SECURITY, qu'on n'utilise volontairement PAS ici). Idem pour
-- la fonction public.sync_auth_user() : SECURITY DEFINER => elle s'exécute avec les
-- droits de son propriétaire (postgres), donc le trigger sur auth.users continue
-- d'insérer dans "User".
--
-- Piège : chaque NOUVELLE table devra avoir son propre ENABLE ROW LEVEL SECURITY
-- dans sa migration (Prisma ne le fait pas). Le test tests/prisma/rls.test.ts
-- échoue si on l'oublie.
--
-- Compatible avec la shadow database de `prisma migrate dev` (Postgres nu) :
-- ENABLE ROW LEVEL SECURITY est du Postgres standard, pas besoin de garde-fou.

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Participant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

-- La table interne de Prisma est elle aussi dans "public", donc exposée par
-- PostgREST (elle révèle l'historique et le SQL des migrations). Prisma migrate
-- tourne en "postgres" (propriétaire) : il n'est pas affecté.
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
