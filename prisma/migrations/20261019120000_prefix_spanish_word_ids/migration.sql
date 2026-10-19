-- Word ids now carry the language they belong to: 'n001' becomes 'es-n001', and the
-- Indonesian words arrive as 'id-n001'. Without the prefix, the two languages would
-- share ids, and the statistics grouped by "wordId" (most missed words) would add up
-- the mistakes made on two different words.
--
-- Data only: no column changes, so the schema (and `prisma migrate diff`) is untouched.
-- Written by hand, Prisma never generates an UPDATE.
--
-- Every answer stored before this migration is Spanish: 'fr-es' and 'es-fr' were the
-- only modes accepted by the route. That is why no join on "QuizSession"."mode" is
-- needed.
--
-- The WHERE clause skips ids that already contain a '-': running this statement a
-- second time, or on a database where some rows were renamed by hand, changes nothing.
-- The old ids (n001, v042...) never contain one.
--
-- Safe only because no version of the app sending the old ids is in use (the app is
-- not deployed yet): an old app would keep writing 'n001' after this migration.

UPDATE "QuizAnswer"
SET "wordId" = 'es-' || "wordId"
WHERE "wordId" NOT LIKE '%-%';
