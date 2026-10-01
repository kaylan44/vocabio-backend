---
name: db-schema
description: Displays the database schema as a simple entity-relationship diagram, built from prisma/schema.prisma. Use when the developer asks to see or visualize the schema, the tables or the relations of the database.
---

# Visualize the database schema

Goal: give the developer a **simple, visual** overview of the tables and their
relations. This is not an audit: no long explanation.

## Source of truth

- Read only `prisma/schema.prisma`.
- **Never** read `.env` / `.env.local` and never connect to the database
  ("Secrets" rule in `CLAUDE.md`). The diagram therefore reflects the Prisma
  schema in the repo, not the actual state of Supabase.
- To flag a possible gap, compare with the `prisma/migrations/` folder: if a
  model or a field of the schema appears in no migration, say so in one line
  under the diagram.

## Steps

1. Read `prisma/schema.prisma` and list the folders in `prisma/migrations/`.
2. Build an entity-relationship diagram:
   - one box per `model`, titled with the model name;
   - one row per scalar field: name, type, and a `PK`, `FK` or `?` (optional)
     marker where it applies. Composite primary keys (`@@id`) mark `PK` on
     each field involved;
   - do not show Prisma relation fields (e.g. `participants Participant[]`)
     as columns: they become connector lines;
   - one line per `@relation`, with its cardinality (1 → N) and the name of
     the foreign key on the line.
3. Display the diagram:
   - if an inline visual rendering tool is available in the session
     (widget / SVG diagram), use it;
   - otherwise, answer with a ```mermaid block of type `erDiagram`;
   - readability: set the colors explicitly instead of keeping mermaid's
     defaults (table titles are unreadable otherwise). Table header on a
     colored background with high-contrast text of the same hue (light:
     background `#CECBF6`, text `#26215C`; dark: background `#3C3489`, text
     `#EEEDFE`), column rows on a neutral background with the primary text
     color.
4. Under the diagram, at most 3 lines in English:
   - the date of the last migration (name of the most recent folder);
   - schema / migrations gaps if any, otherwise nothing;
   - constraints that a diagram does not show but that matter (e.g. RLS
     enabled, `@@unique`, `@@index`), only if they exist.

## Arguments

- No argument: the whole schema.
- With a model name (e.g. `/db-schema Message`): that model and its direct
  neighbors only.

## Do not

- Do not modify any file (read-only skill).
- Do not run `prisma db pull`, `prisma migrate` or any command that touches
  the database.
