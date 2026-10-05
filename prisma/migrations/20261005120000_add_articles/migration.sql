-- Articles: one "Article" row per article copied from an external source, and one
-- "ArticleAudio" row holding its MP3 reading. Design choices (two ids, JSON content,
-- audio in its own table) are explained in prisma/schema.prisma.
--
-- The CREATE / INDEX / FOREIGN KEY statements below are the ones Prisma generates from
-- the schema (`prisma migrate diff`, run without a database). The two ENABLE ROW LEVEL
-- SECURITY lines at the end are added by hand: Prisma never writes them.

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "level" TEXT,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "url" TEXT NOT NULL,
    "audioSourceUrl" TEXT,
    "audioDurationSec" INTEGER,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleAudio" (
    "articleId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,

    CONSTRAINT "ArticleAudio_pkey" PRIMARY KEY ("articleId")
);

-- CreateIndex
CREATE INDEX "Article_publishedAt_idx" ON "Article"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Article_source_externalId_key" ON "Article"("source", "externalId");

-- AddForeignKey
ALTER TABLE "ArticleAudio" ADD CONSTRAINT "ArticleAudio_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security, enabled with NO policy = "deny everything" for the anon and
-- authenticated roles used by the Supabase Data API (PostgREST). Without it, anyone
-- holding the public anon key could read the articles and download the audio directly,
-- bypassing this backend and its authentication. Prisma connects as the table owner
-- and is not affected.
-- Same pattern as 20260929120000_enable_rls; tests/prisma/rls.test.ts fails if a
-- CREATE TABLE has no matching line here.
ALTER TABLE "Article" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArticleAudio" ENABLE ROW LEVEL SECURITY;
