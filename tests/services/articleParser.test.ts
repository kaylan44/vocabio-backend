// Unit tests of the article parser.
//
// The parser is pure (no network, no database), so nothing is mocked here: we give
// it a post and look at what comes out.
//
// The HTML fixtures are WRITTEN BY HAND with the same structure as the source's pages
// (audio block, subscribe links, image, paragraphs with tooltips, trailing section).
// They are not copies of real articles. What these tests cannot prove: that the real
// site still has this structure. That is checked by a manual run against the live API.

import {
  ArticleBlock,
  buildExcerpt,
  EXCERPT_MAX_LENGTH,
  parseIsoDuration,
  parsePost,
} from '../../src/services/articleParser';

// ─────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────

// A vocabulary tooltip as the source's plugin writes it: the visible phrase, then a
// hidden span holding the English gloss, linked by aria-describedby → id.
const tooltip = (id: string, phrase: string, gloss: string): string =>
  `<span id="${id}_button" class="su-tooltip-button su-tooltip-button-outline-yes" aria-describedby="${id}" tabindex="0">${phrase}</span>` +
  `<span style="display:none;z-index:100" id="${id}" class="su-tooltip" role="tooltip">` +
  `<span class="su-tooltip-inner su-tooltip-shadow-no"><span class="su-tooltip-title"></span>` +
  `<span class="su-tooltip-content su-u-trim">${gloss}</span></span>` +
  `<span id="${id}_arrow" class="su-tooltip-arrow" data-popper-arrow></span></span>`;

const AUDIO_URL = 'https://holaquepasa.com/wp-content/uploads/2026/09/el-gato.mp3';

const audioBlock = (url = AUDIO_URL, duration = 'PT3M52S'): string =>
  `<div itemscope itemtype="http://schema.org/AudioObject">` +
  `<meta itemprop="name" content="El gato" />` +
  `<meta itemprop="duration" content="${duration}" />` +
  `<meta itemprop="contentUrl" content="${url}" />` +
  `<div class="powerpress_player"><audio class="wp-audio-shortcode" controls="controls">` +
  `<source type="audio/mpeg" src="${url}?_=2" /><a href="${url}">${url}</a></audio></div></div>` +
  `<p class="powerpress_links powerpress_subscribe_links">Podcast: <a href="https://podcasts.example/x">Apple Podcasts</a></p>`;

const IMAGE_BLOCK =
  '<figure class="wp-block-image aligncenter size-full"><img src="https://holaquepasa.com/wp-content/uploads/2026/09/gato.jpg" alt="Un gato" /><figcaption>Foto de un gato</figcaption></figure>';

const GRAMMAR_SECTION =
  '<section class="wp-block-uagb-section"><div class="uagb-section__inner-wrap">' +
  '<h3 class="wp-block-heading">For this article</h3>' +
  '<ul class="wp-block-list"><li><a href="https://holaquepasa.com/the-numbers/"><strong>The Numbers</strong></a> (uno, dos)</li></ul>' +
  '<p>Texto dentro de la sección</p>' +
  '</div></section>';

const BODY =
  `<p>El gato vive en ${tooltip('t1', 'una casa pequeña', 'a small house')}. Come mucho.</p>\n\n\n` +
  `<p></p>\n` +
  `<p>Por la noche, el gato <strong>duerme</strong> en el <a href="https://holaquepasa.com/sofa/">sofá</a>.</p>`;

const html = (body = BODY): string => `\n${audioBlock()}\n${IMAGE_BLOCK}\n${body}\n${GRAMMAR_SECTION}`;

// A post as returned by /wp-json/wp/v2/posts with the fields we ask for.
const makePost = (overrides: Record<string, unknown> = {}) => ({
  id: 74003,
  date_gmt: '2026-10-03T12:00:00',
  link: 'https://holaquepasa.com/el-gato-de-la-casa/',
  title: { rendered: 'El gato &#8220;Tom&#8221; &amp; la casa' },
  categories: [331, 23],
  content: { rendered: html() },
  _embedded: {
    'wp:featuredmedia': [
      { source_url: 'https://holaquepasa.com/wp-content/uploads/2026/09/gato.jpg' },
    ],
  },
  ...overrides,
});

const textOf = (block: ArticleBlock): string => block.segments.map((s) => s.text).join('');

describe('articleParser', () => {
  // ─────────────────────────────────────────────
  describe('parsePost — fields', () => {
    it('extracts the id, link, date, level, image and audio of a complete post', () => {
      const article = parsePost(makePost());

      expect(article).not.toBeNull();
      expect(article).toMatchObject({
        externalId: '74003',
        url: 'https://holaquepasa.com/el-gato-de-la-casa/',
        level: 'easy',
        imageUrl: 'https://holaquepasa.com/wp-content/uploads/2026/09/gato.jpg',
        audioSourceUrl: AUDIO_URL,
        audioDurationSec: 232,
      });
    });

    it('reads date_gmt as UTC even though it has no Z', () => {
      // Without the fix, '2026-10-03T12:00:00' would be read in the server's local
      // time zone and the stored date would depend on where the server runs.
      const article = parsePost(makePost());

      expect(article?.publishedAt.toISOString()).toBe('2026-10-03T12:00:00.000Z');
    });

    it('decodes the HTML entities of the title', () => {
      expect(parsePost(makePost())?.title).toBe('El gato “Tom” & la casa');
    });

    it('maps the category ids to a level', () => {
      expect(parsePost(makePost({ categories: [23, 331] }))?.level).toBe('easy');
      expect(parsePost(makePost({ categories: [332, 23] }))?.level).toBe('intermediate');
      // News with no level category, or a missing field: the article is kept.
      expect(parsePost(makePost({ categories: [23] }))?.level).toBeNull();
      expect(parsePost(makePost({ categories: undefined }))?.level).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  describe('parsePost — body', () => {
    it('keeps only the article paragraphs, in order', () => {
      const article = parsePost(makePost());

      // 2 paragraphs: the empty <p> is dropped, and so is everything that is not a
      // top-level <p> (player, subscribe links, image caption, grammar section).
      expect(article?.content.map(textOf)).toEqual([
        'El gato vive en una casa pequeña. Come mucho.',
        'Por la noche, el gato duerme en el sofá.',
      ]);
    });

    it('drops the player, the subscribe links, the image and the trailing section', () => {
      const article = parsePost(makePost());
      const allText = article!.content.map(textOf).join(' ');

      expect(allText).not.toContain('Podcast');
      expect(allText).not.toContain('Foto de un gato');
      expect(allText).not.toContain('For this article');
      expect(allText).not.toContain('Texto dentro de la sección');
      expect(allText).not.toContain('.mp3');
    });

    it('turns a tooltip into one segment with its gloss, with no hole and no leak', () => {
      const article = parsePost(makePost());

      expect(article?.content[0].segments).toEqual([
        { text: 'El gato vive en ' },
        { text: 'una casa pequeña', gloss: 'a small house' },
        { text: '. Come mucho.' },
      ]);
      // The English gloss must never appear in the Spanish text.
      expect(textOf(article!.content[0])).not.toContain('a small house');
    });

    it('keeps the phrase as plain text when its gloss cannot be found', () => {
      // The button points to an id that does not exist: we must not lose the phrase.
      const body = '<p>Vive en <span class="su-tooltip-button" aria-describedby="missing">una casa</span> azul.</p>';
      const article = parsePost(makePost({ content: { rendered: html(body) } }));

      expect(article?.content[0].segments).toEqual([{ text: 'Vive en una casa azul.' }]);
    });

    it('merges inline formatting into the surrounding text', () => {
      const article = parsePost(makePost());

      // <strong> and <a> are dropped, their text stays in ONE segment.
      expect(article?.content[1].segments).toEqual([
        { text: 'Por la noche, el gato duerme en el sofá.' },
      ]);
    });

    it('collapses whitespace, line breaks and non-breaking spaces', () => {
      const body = '<p>  Uno\n   dos<br>tres&nbsp;&nbsp;cuatro  </p>';
      const article = parsePost(makePost({ content: { rendered: html(body) } }));

      expect(textOf(article!.content[0])).toBe('Uno dos tres cuatro');
    });

    it('never emits a script or a style', () => {
      const body = '<p>Hola<script>alert(1)</script><style>p{color:red}</style> mundo.</p>';
      const article = parsePost(makePost({ content: { rendered: html(body) } }));

      expect(textOf(article!.content[0])).toBe('Hola mundo.');
    });

    it('stores text, not markup: tags written as entities stay inert text', () => {
      // '&lt;b&gt;' is the TEXT "<b>", not a tag. It must come out as those characters
      // and nothing must be interpreted.
      const body = '<p>Escribe &lt;b&gt;hola&lt;/b&gt; aquí.</p>';
      const article = parsePost(makePost({ content: { rendered: html(body) } }));

      expect(textOf(article!.content[0])).toBe('Escribe <b>hola</b> aquí.');
    });

    it('builds the excerpt from the beginning of the text', () => {
      expect(parsePost(makePost())?.excerpt).toBe(
        'El gato vive en una casa pequeña. Come mucho. Por la noche, el gato duerme en el sofá.'
      );
    });
  });

  // ─────────────────────────────────────────────
  describe('parsePost — audio and image are optional and never trusted', () => {
    it('keeps the article without audio when the post has no audio block', () => {
      const article = parsePost(makePost({ content: { rendered: BODY } }));

      expect(article).not.toBeNull();
      expect(article?.audioSourceUrl).toBeNull();
      expect(article?.audioDurationSec).toBeNull();
    });

    it('ignores an audio URL that is not on the source host', () => {
      const body = `${audioBlock('https://evil.test/track.mp3')}${BODY}`;
      const article = parsePost(makePost({ content: { rendered: body } }));

      expect(article).not.toBeNull();
      expect(article?.audioSourceUrl).toBeNull();
      // No duration either: it would describe a file we will never download.
      expect(article?.audioDurationSec).toBeNull();
    });

    it('ignores an audio URL that is not https', () => {
      const body = `${audioBlock('http://holaquepasa.com/track.mp3')}${BODY}`;

      expect(parsePost(makePost({ content: { rendered: body } }))?.audioSourceUrl).toBeNull();
    });

    it('ignores an image that is not on the source host, or a malformed _embedded', () => {
      const foreign = { 'wp:featuredmedia': [{ source_url: 'https://evil.test/x.jpg' }] };

      expect(parsePost(makePost({ _embedded: foreign }))?.imageUrl).toBeNull();
      expect(parsePost(makePost({ _embedded: undefined }))?.imageUrl).toBeNull();
      expect(parsePost(makePost({ _embedded: { 'wp:featuredmedia': [null] } }))?.imageUrl).toBeNull();
      expect(parsePost(makePost({ _embedded: { 'wp:featuredmedia': 'nope' } }))?.imageUrl).toBeNull();
    });

    it('keeps the audio but no duration when the duration is unreadable', () => {
      const body = `${audioBlock(AUDIO_URL, 'about four minutes')}${BODY}`;
      const article = parsePost(makePost({ content: { rendered: body } }));

      expect(article?.audioSourceUrl).toBe(AUDIO_URL);
      expect(article?.audioDurationSec).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  describe('parsePost — unusable posts give null and never throw', () => {
    it.each([
      ['a missing id', { id: undefined }],
      ['an id that is not a positive integer', { id: '74003' }],
      ['a negative id', { id: -1 }],
      ['a missing link', { link: undefined }],
      ['a link to another host', { link: 'https://evil.test/el-gato/' }],
      ['a look-alike host', { link: 'https://holaquepasa.com.evil.test/el-gato/' }],
      ['a missing date', { date_gmt: undefined }],
      ['an unreadable date', { date_gmt: 'yesterday' }],
      ['a missing title', { title: undefined }],
      ['an empty title', { title: { rendered: '   ' } }],
      ['a missing content', { content: undefined }],
      ['a content that is not a string', { content: { rendered: 42 } }],
      ['a content with no paragraph', { content: { rendered: `${audioBlock()}${IMAGE_BLOCK}` } }],
      ['only empty paragraphs', { content: { rendered: '<p></p><p>   </p>' } }],
    ])('returns null for %s', (_label, overrides) => {
      expect(parsePost(makePost(overrides))).toBeNull();
    });

    it.each([[null], [undefined], [42], ['a string'], [[]], [{}]])(
      'returns null for the garbage input %p',
      (input) => {
        expect(() => parsePost(input)).not.toThrow();
        expect(parsePost(input)).toBeNull();
      }
    );

    it('survives broken HTML', () => {
      const body = '<p>Texto <span class="su-tooltip-button">sin cerrar <p>Otro</p';

      expect(() => parsePost(makePost({ content: { rendered: body } }))).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────
  describe('parseIsoDuration', () => {
    it.each([
      ['PT3M52S', 232],
      ['PT45S', 45],
      ['PT5M', 300],
      ['PT1H2M3S', 3723],
    ])('reads %s as %d seconds', (input, expected) => {
      expect(parseIsoDuration(input)).toBe(expected);
    });

    it.each([['PT'], ['PT0S'], ['3:52'], [''], ['P1D'], [232], [null], [undefined], ['PT99999H']])(
      'returns null for %p',
      (input) => {
        expect(parseIsoDuration(input)).toBeNull();
      }
    );
  });

  // ─────────────────────────────────────────────
  describe('buildExcerpt', () => {
    const paragraph = (text: string): ArticleBlock => ({ type: 'paragraph', segments: [{ text }] });

    it('returns a short text unchanged', () => {
      expect(buildExcerpt([paragraph('Hola.'), paragraph('Adiós.')])).toBe('Hola. Adiós.');
    });

    it('cuts a long text on a word boundary and adds an ellipsis', () => {
      const excerpt = buildExcerpt([paragraph('palabra '.repeat(60))]);

      expect(excerpt.endsWith('palabra…')).toBe(true);
      // +1 for the ellipsis character itself.
      expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_LENGTH + 1);
    });

    it('cuts hard when there is no space to cut on', () => {
      const excerpt = buildExcerpt([paragraph('a'.repeat(500))]);

      expect(excerpt).toBe(`${'a'.repeat(EXCERPT_MAX_LENGTH)}…`);
    });
  });
});
