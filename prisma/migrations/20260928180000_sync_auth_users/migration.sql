-- Synchronise la table "User" avec auth.users (Supabase Auth).
--
-- Pourquoi : "User" n'était alimentée que par l'upsert lazy du middleware auth
-- (première requête authentifiée) et par un webhook optionnel. Un utilisateur
-- inscrit mais n'ayant jamais appelé l'API était donc introuvable dans
-- GET /users et /users/search.
--
-- Le bloc est conditionnel : le schéma "auth" n'existe que sur Supabase. Sans ce
-- garde-fou, la shadow database de `prisma migrate dev` (Postgres nu) échouerait.

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    RAISE NOTICE 'Schéma auth absent : synchronisation auth.users ignorée';
    RETURN;
  END IF;

  -- Même règle de username que src/middleware/auth.ts et src/routes/webhooks.ts
  CREATE OR REPLACE FUNCTION public.sync_auth_user()
  RETURNS trigger
  LANGUAGE plpgsql
  -- Exécutée par le rôle de Supabase Auth, qui n'a pas de droits sur public."User"
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  BEGIN
    INSERT INTO public."User" ("id", "username", "avatarUrl")
    VALUES (
      NEW.id::text,
      COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1),
        'Utilisateur'
      ),
      NEW.raw_user_meta_data->>'avatar_url'
    )
    -- Ne jamais écraser : l'upsert lazy a pu créer la ligne avant
    ON CONFLICT ("id") DO NOTHING;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
  CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.sync_auth_user();

  -- Rattrapage des comptes existants
  INSERT INTO public."User" ("id", "username", "avatarUrl")
  SELECT
    u.id::text,
    COALESCE(
      u.raw_user_meta_data->>'full_name',
      u.raw_user_meta_data->>'name',
      split_part(u.email, '@', 1),
      'Utilisateur'
    ),
    u.raw_user_meta_data->>'avatar_url'
  FROM auth.users u
  ON CONFLICT ("id") DO NOTHING;
END
$migration$;
