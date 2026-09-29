// Garde-fou : toute table créée par une migration doit avoir le RLS activé.
//
// Pourquoi un test sur les fichiers SQL plutôt que sur la base : on n'a pas encore
// de base de test (tout est mocké). On vérifie donc la "source de vérité" du schéma,
// les migrations. Ce test ne prouve PAS que la migration a été appliquée sur Supabase :
// seulement qu'on n'oublie pas d'écrire le ENABLE ROW LEVEL SECURITY.
//
// Contexte : sans RLS, une table de "public" est lisible/modifiable par n'importe qui
// via le Data API Supabase avec la clé anon (voir migration 20260929120000_enable_rls).

import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '../../prisma/migrations');

// Concatène le SQL de toutes les migrations, dans l'ordre (les dossiers sont
// préfixés par un timestamp, donc le tri alphabétique = ordre chronologique).
const readAllMigrations = (): string =>
  fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
    .join('\n');

// Extrait les noms de tables d'un SQL. Prisma génère toujours `CREATE TABLE "Nom"`
// (avec guillemets), c'est ce format qu'on cible.
const extract = (sql: string, regex: RegExp): Set<string> =>
  new Set(Array.from(sql.matchAll(regex), (match) => match[1]));

const CREATE_TABLE = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"public"\.)?"([^"]+)"/gi;
const ENABLE_RLS = /ALTER TABLE\s+(?:"public"\.)?"([^"]+)"\s+ENABLE ROW LEVEL SECURITY/gi;

describe('RLS sur les tables Prisma', () => {
  const sql = readAllMigrations();
  const created = extract(sql, CREATE_TABLE);
  const protectedTables = extract(sql, ENABLE_RLS);

  it('trouve bien les tables du schéma (sinon la regex est cassée et le test ne prouve rien)', () => {
    // arrayContaining et pas toEqual : ajouter une table ne doit pas casser CE test-ci,
    // c'est le test suivant qui vérifiera son RLS.
    expect([...created]).toEqual(
      expect.arrayContaining(['User', 'Conversation', 'Participant', 'Message']),
    );
  });

  it('active le RLS sur chaque table créée par une migration', () => {
    const missing = [...created].filter((table) => !protectedTables.has(table));
    // Si ce test échoue : ajouter `ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;`
    // dans la migration qui crée la table.
    expect(missing).toEqual([]);
  });

  it('active aussi le RLS sur la table interne _prisma_migrations', () => {
    expect(protectedTables.has('_prisma_migrations')).toBe(true);
  });
});
