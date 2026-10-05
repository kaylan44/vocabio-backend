# Plan — Easy Spanish articles with audio, backend (`vocabio-backend`)

## Context

The mobile app (`vocabio2`) only offers vocabulary quizzes today. Goal: a separate
"read an easy article" section, fed by an external source. The backend aggregates the
articles (text, level, audio), stores them, and serves them to the app.

Source: **Hola Qué Pasa** (`holaquepasa.com`), one short news article per day written
for Spanish learners, each with an MP3 reading.

Decisions already taken with the developer:

- **No vocabulary matching.** Articles are a section of their own, unrelated to the quiz.
- **Full text read inside the app**, not a link out.
- **No image.** Nothing about images is fetched, stored or served: not the file, not
  its address. The `<figure>` of the article body is dropped with the rest of the
  non-text markup.
- **Audio is copied**, not streamed from the source, and stored **in PostgreSQL**
  (`bytea`), not in a file storage. The app downloads the bytes with a normal
  authenticated `fetch` and plays them locally.
- **Private testing only.** The site is "Copyright © 2026" with no reuse licence and its
  terms say nothing about the API. Copying text and audio is acceptable for a private
  test; it needs the publisher's agreement before anyone else uses the app. Hence the
  feature flag below, off by default.
- **Scope**: this file covers the backend only. The app part is done later in `vocabio2`.

Facts that shape the design (checked against the live site on 2026-10-05):

- The RSS feed has no full text and a truncated summary with holes. The public
  **WordPress REST API** (`/wp-json/wp/v2/posts`) has everything, with no authentication.
- News posts are in category `23`; its children give the level: `331` = Easy,
  `332` = Intermediate. Grammar lessons (`22`, `51`) are other categories: filtering on
  `categories=23` excludes them.
- `content.rendered` is HTML with a stable shape:
  1. a `schema.org/AudioObject` block: `<meta itemprop="contentUrl">` (MP3 URL) and
     `<meta itemprop="duration">` (ISO 8601, e.g. `PT3M52S`), then the audio player;
  2. a `<p class="powerpress_links">` paragraph (podcast subscribe links);
  3. a `<figure class="wp-block-image">`;
  4. the article: plain `<p>` paragraphs;
  5. a trailing `<section class="wp-block-uagb-section">` with links to grammar lessons.
- Inside the paragraphs, some phrases carry a vocabulary tooltip: a
  `span.su-tooltip-button` (the Spanish phrase) followed by a hidden `span.su-tooltip`
  whose `.su-tooltip-content` is an **English** gloss. About 14 per article.
- An MP3 is about 1.5 to 3 MB. One article per day, published at 12:00 UTC.
- The backend runs as **one** Railway instance (Socket.io has no adapter), so an
  in-process timer is enough. There is no file storage and the disk is ephemeral.
- There is no test database: `prisma migrate dev` cannot be used. The migration SQL is
  generated offline and applied by `prisma migrate deploy` when Railway starts the app.

**Branch:** `feat/articles`, created from `main` at `4f93974`.

## 1. Data model — `prisma/schema.prisma`

```prisma
model Article {
  id               String   @id @default(uuid())
  source           String                 // 'holaquepasa'
  externalId       String                 // post id at the source, e.g. '74003'
  lang             String                 // 'es'
  level            String?                // 'easy' | 'intermediate' | null if unknown
  title            String
  excerpt          String                 // first ~200 characters, for the list
  content          Json                   // ArticleBlock[] (see section 3), never HTML
  url              String                 // link to the original article (attribution)
  audioSourceUrl   String?                // where the MP3 was found; null = no audio
  audioDurationSec Int?
  publishedAt      DateTime
  createdAt        DateTime @default(now())

  audio ArticleAudio?

  @@unique([source, externalId])          // dedupe key of the ingestion
  @@index([publishedAt])
}

model ArticleAudio {
  articleId String @id
  data      Bytes                         // the MP3 itself
  mimeType  String                        // 'audio/mpeg'
  size      Int                           // bytes, so Content-Length needs no data read

  article Article @relation(fields: [articleId], references: [id], onDelete: Cascade)
}
```

Why these choices:

- **Audio in its own table.** A `findMany` on `Article` can never drag megabytes of
  MP3 along by mistake, with no `select` discipline to remember.
- **`content` as structured JSON, not HTML.** The app has no HTML renderer and must not
  get one for this; and plain text removes any script-injection risk on web.
- **`level` / `lang` / `source` as `String`**, same reasoning as `QuizSession.mode`.
- **`hasAudio` is not a column.** It is derived by the service (`audio` relation present).
- The `publishedAt` index is honest overkill for ~30 rows; it costs nothing and matches
  the only sort used.

Migration `prisma/migrations/<timestamp>_add_articles/migration.sql`:

- generated with `prisma migrate diff --from-schema-datamodel <main schema>
  --to-schema-datamodel prisma/schema.prisma --script` (no database connection);
- plus, by hand: `ALTER TABLE "Article" ENABLE ROW LEVEL SECURITY;` and the same for
  `"ArticleAudio"` (`tests/prisma/rls.test.ts` fails otherwise).

## 2. Source client — `src/lib/holaQuePasa.ts`

HTTP only, no parsing, no Prisma. Uses Node's global `fetch` (Node ≥ 18; CI runs 24).

- `fetchLatestPosts(limit): Promise<WpPost[]>`
  `GET https://holaquepasa.com/wp-json/wp/v2/posts?categories=23&per_page=<limit>`
  `&_fields=id,date_gmt,link,title,categories,content`
- `downloadAudio(url): Promise<{ data: Buffer; mimeType: string }>`
- Shared rules: 20 s timeout (`AbortSignal.timeout`), an explicit `User-Agent` naming
  the project, non-2xx → throw.
- `downloadAudio` guards, because the URL comes from remote content:
  - `https:` and host exactly `holaquepasa.com`, checked with `new URL()` **before** any
    request, and `redirect: 'error'` (no redirect to another host);
  - `Content-Type` must start with `audio/`;
  - size capped at `MAX_AUDIO_BYTES` (10 MB): refuse on `Content-Length`, and stop
    reading the stream if the cap is passed anyway.

## 3. Parser — `src/services/articleParser.ts`

Pure functions, no I/O: the part most likely to break when the site changes, so the
part with the most tests.

```ts
type ArticleSegment = { text: string; gloss?: string };   // gloss = English tooltip
type ArticleBlock = { type: 'paragraph'; segments: ArticleSegment[] };

interface ParsedArticle {
  externalId: string; title: string; url: string; level: ArticleLevel | null;
  publishedAt: Date;
  audioSourceUrl: string | null; audioDurationSec: number | null;
  excerpt: string; content: ArticleBlock[];
}

parsePost(post: unknown): ParsedArticle | null   // null = not usable, never throws
```

Rules:

- New dependency: **`node-html-parser`** (small, DOM-like). Regexes cannot reliably
  handle the nested tooltip spans. Pinned to version 7: version 9 pulls `entities@8`,
  which requires Node ≥ 20.19, and nothing pins the Node version used on Railway.
- Audio: `meta[itemprop=contentUrl]` and `meta[itemprop=duration]` (`PT3M52S` → 232).
- Article body: only `<p>` elements that are direct children of the content root, minus
  those with a `powerpress_*` class. This drops the player, the image and the trailing
  grammar section in one rule.
- Each paragraph becomes segments: plain text, and for each tooltip
  `{ text: <button text>, gloss: <.su-tooltip-content text> }`. The hidden tooltip span
  is never emitted as text (this is what left holes in the RSS summary).
- Entities decoded, whitespace collapsed, empty paragraphs dropped.
- `level` from `categories` (`331` → `easy`, `332` → `intermediate`).
- `title.rendered` is HTML-escaped by WordPress: decode it.
- Returns `null` when the id, title, date or body is missing. An article without audio
  is still valid.

## 4. Ingestion — `src/services/articleIngestService.ts`

```
runIngestion(): Promise<{ created, audioAdded, skipped, failed, purged }>

1. fetchLatestPosts(INGEST_BATCH_SIZE = 10)
2. parsePost each one; null → failed++
3. Load existing rows for these externalIds (id + whether audio exists)
4. For each parsed article:
   - not stored  → download audio (failure tolerated) → create Article
                   (+ nested ArticleAudio if downloaded)            → created++
   - stored, no audio, has audioSourceUrl → retry the download     → audioAdded++
   - stored with audio → skipped++ (text is not refreshed)
5. Purge: delete articles with publishedAt older than RETENTION_DAYS = 30
   (cascade removes their audio)                                     → purged
```

- One article failing (bad HTML, audio timeout, unique violation `P2002` from an
  overlapping run) never stops the others: caught per article, logged with
  `console.warn` (ids and reason only, never content).
- Articles are processed **sequentially**: at most one MP3 in memory at a time, and a
  polite load on the source.
- First run backfills the 10 latest articles (about 20 MB of audio). Steady state: one
  new article per day, about 60 MB kept in total.

## 5. Scheduler — `src/jobs/articleScheduler.ts`

- `startArticleScheduler()`: does nothing unless `ARTICLES_SYNC_ENABLED === 'true'`.
- First run 30 s after boot (lets the server start and answer the health check), then
  every `SYNC_INTERVAL_HOURS = 6`.
- A boolean guard skips a tick if the previous run is still going.
- Timers are `unref()`-ed, and the scheduler is started from `src/app.ts` only: tests
  import routers and services, never `app.ts`, so no timer leaks into Jest.
- If the app ever runs on several instances, this moves to a Railway cron service
  calling `runIngestion()`; the service does not change.

## 6. Read side — `src/services/articleService.ts` + `src/routes/articles.ts`

All three routes go through `authMiddleware` (guests have no access, like statistics).

| Route | Response |
|---|---|
| `GET /articles?level=&offset=0&limit=20` | `{ articles: ArticleSummary[], pagination: { offset, limit, count } }` |
| `GET /articles/:id` | `ArticleSummary & { content: ArticleBlock[] }` |
| `GET /articles/:id/audio` | the MP3 bytes |

```ts
ArticleSummary = { id, source, lang, level, title, excerpt, url,
                   publishedAt, hasAudio, audioDurationSec }
```

- List: newest first, optional `level` filter. Same pagination shape and bounds as
  `GET /conversations/:id/messages` (`limit` 1–50, default 20; bounded `offset`).
- `audioSourceUrl` and `externalId` are internal: never returned.
- Audio: `Content-Type` from the row, `Content-Length` from `size`,
  `Cache-Control: private, max-age=86400`, body sent in one piece (no `Range`: the app
  downloads the whole file, then seeks locally).
- Validation in the route: `id` must be a UUID (400), `level` one of
  `easy | intermediate` (400). Unknown id or no audio → 404 thrown by the service with
  the usual `statusCode` convention.

`src/app.ts`: mount `app.use('/articles', articleRouter)` and call
`startArticleScheduler()` after `listen`.

## 7. Tests

Prisma and the source client are mocked, as everywhere else. HTML fixtures are
**written by hand** with the same structure as the site, not copied from it.

- `tests/services/articleParser.test.ts`: body paragraphs kept in order; player,
  subscribe links, image and grammar section dropped; tooltip → `{ text, gloss }` with
  no hidden text leaking and no hole; entities decoded; duration parsing; level
  mapping; no image kept; missing fields → `null`; garbage input → `null`
  without throwing.
- `tests/lib/holaQuePasa.test.ts` (`fetch` mocked): query string; non-2xx throws;
  `downloadAudio` refuses another host, `http:`, a non-audio type, an oversized
  `Content-Length`, an oversized stream.
- `tests/services/articleIngestService.test.ts`: new article created with its audio;
  audio failure → article created without audio; stored article without audio →
  retried; stored with audio → no download; one bad post does not stop the batch;
  purge uses the 30-day cutoff; counters returned.
- `tests/services/articleService.test.ts`: list order, filter, pagination, internal
  fields absent, `hasAudio`; 404s.
- `tests/routes/articles.test.ts` (supertest, service mocked): 400 on bad `id` /
  `level`; 404 propagated; audio headers and body bytes; 401 without the auth mock.
- `tests/jobs/articleScheduler.test.ts` (fake timers): nothing scheduled without the
  flag; first run then interval; no overlapping run.
- `tests/prisma/rls.test.ts` covers the new migration with no change.

What these tests do **not** prove: that the real site still has this HTML shape, and
that the migration applies on Supabase. A one-off manual run of the parser against the
live API (no database) is done before the first deployment, and its result reported.

## 8. Configuration and docs

- `.env.example`: `ARTICLES_SYNC_ENABLED="false"` with a comment.
- `package.json`: add `node-html-parser`.
- `README.md`: data model (two tables), the three endpoints, the variable, a "Step 7".
- `PLAN.md`: short "Step 7" section pointing here, and rows in the decisions table.
- `CLAUDE.md`: "The project in short" mentions the third feature.

## 9. Commits (Conventional Commits, no push)

1. `docs: add the articles plan`
2. `feat: add Article and ArticleAudio models with migration`
3. `feat: add the Hola Qué Pasa client and the article parser`
4. `feat: add article ingestion and its scheduler`
5. `feat: add /articles routes`
6. `docs: document articles`

Then `/code-review` and `/security-review` on the branch, as the process requires.

## 10. Deployment notes (for the developer)

- Merging deploys the two empty tables. Nothing is fetched until
  `ARTICLES_SYNC_ENABLED=true` is set on Railway.
- Turning the flag off stops new fetches; stored articles stay readable until purged
  by the next enabled run. To remove everything: `DELETE FROM "Article";`.

## Out of scope

- The `vocabio2` part (screens, audio player, `expo-audio`).
- A second source or French articles (the model already allows them).
- Refreshing the text of an already stored article.
- `Range` requests, file storage, a manual "sync now" endpoint.
- Per-user state (read / unread, favourites).
