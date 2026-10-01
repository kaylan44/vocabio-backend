-- Quiz results: one "QuizSession" row per finished quiz, one "QuizAnswer" row per question.
-- Design choices (client-generated id, String instead of enum, copied category/level)
-- are explained in prisma/schema.prisma.
--
-- The CREATE / INDEX / FOREIGN KEY statements below are the ones Prisma generates from
-- the schema. The two ENABLE ROW LEVEL SECURITY lines at the end are added by hand:
-- Prisma never writes them.

-- CreateTable
CREATE TABLE "QuizSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAnswer" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "wordId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,

    CONSTRAINT "QuizAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizSession_userId_createdAt_idx" ON "QuizSession"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuizAnswer_sessionId_position_key" ON "QuizAnswer"("sessionId", "position");

-- AddForeignKey
ALTER TABLE "QuizSession" ADD CONSTRAINT "QuizSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAnswer" ADD CONSTRAINT "QuizAnswer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "QuizSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security, enabled with NO policy = "deny everything" for the anon and
-- authenticated roles used by the Supabase Data API (PostgREST). Without it, anyone
-- holding the public anon key could read or forge quiz results directly, bypassing
-- this backend. Prisma connects as the table owner and is not affected.
-- Same pattern as 20260929120000_enable_rls; tests/prisma/rls.test.ts fails if a
-- CREATE TABLE has no matching line here.
ALTER TABLE "QuizSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuizAnswer" ENABLE ROW LEVEL SECURITY;
