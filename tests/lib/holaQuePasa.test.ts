// Tests of the article source client.
//
// `fetch` is replaced by a mock: no request ever leaves the machine. The responses
// are real `Response` objects (a Node global), so the code under test reads headers
// and streams exactly as it would in production.

import {
  downloadAudio,
  fetchLatestPosts,
  isSourceUrl,
  MAX_AUDIO_BYTES,
  NEWS_CATEGORY_ID,
} from '../../src/lib/holaQuePasa';

const mockFetch = jest.fn();
const realFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => mockFetch.mockReset());

const AUDIO_URL = 'https://holaquepasa.com/wp-content/uploads/2026/09/el-gato.mp3';

const audioResponse = (body: Uint8Array, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', ...headers } });

describe('holaQuePasa client', () => {
  // ─────────────────────────────────────────────
  describe('isSourceUrl', () => {
    it('accepts an https URL on the source host', () => {
      expect(isSourceUrl(AUDIO_URL)).toBe(true);
      expect(isSourceUrl('https://holaquepasa.com/')).toBe(true);
    });

    // Each of these is a classic way to slip another destination past a naive
    // `startsWith('https://holaquepasa.com')` check.
    it.each([
      ['plain http', 'http://holaquepasa.com/a.mp3'],
      ['another host', 'https://evil.test/a.mp3'],
      ['a look-alike suffix', 'https://holaquepasa.com.evil.test/a.mp3'],
      ['a look-alike prefix', 'https://evilholaquepasa.com/a.mp3'],
      ['a subdomain', 'https://cdn.holaquepasa.com/a.mp3'],
      ['credentials before the real host', 'https://holaquepasa.com@evil.test/a.mp3'],
      ['a username on the right host', 'https://user@holaquepasa.com/a.mp3'],
      ['an explicit port', 'https://holaquepasa.com:8443/a.mp3'],
      ['a relative URL', '/wp-content/a.mp3'],
      ['a protocol-relative URL', '//holaquepasa.com/a.mp3'],
      ['a file URL', 'file:///etc/passwd'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['an empty string', ''],
    ])('refuses %s', (_label, url) => {
      expect(isSourceUrl(url)).toBe(false);
    });

    it.each([[null], [undefined], [42], [{}], [['https://holaquepasa.com/']]])(
      'refuses the non-string value %p',
      (value) => {
        expect(isSourceUrl(value)).toBe(false);
      }
    );
  });

  // ─────────────────────────────────────────────
  describe('fetchLatestPosts', () => {
    it('asks the source for the latest news posts, and for no image', async () => {
      mockFetch.mockResolvedValue(Response.json([{ id: 1 }, { id: 2 }]));

      const posts = await fetchLatestPosts(10);

      expect(posts).toEqual([{ id: 1 }, { id: 2 }]);

      const url = new URL(String(mockFetch.mock.calls[0][0]));
      expect(url.origin).toBe('https://holaquepasa.com');
      expect(url.pathname).toBe('/wp-json/wp/v2/posts');
      expect(url.searchParams.get('categories')).toBe(String(NEWS_CATEGORY_ID));
      expect(url.searchParams.get('per_page')).toBe('10');
      // Images are deliberately not fetched: neither the embedded featured image nor
      // the fields that carry it are requested.
      expect(url.searchParams.has('_embed')).toBe(false);
      expect(url.searchParams.get('_fields')).toBe('id,date_gmt,link,title,categories,content');
    });

    it('sends a timeout signal so a silent source cannot hang the job', async () => {
      mockFetch.mockResolvedValue(Response.json([]));

      await fetchLatestPosts(10);

      expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('throws when the source answers an error status', async () => {
      mockFetch.mockResolvedValue(new Response('nope', { status: 503 }));

      await expect(fetchLatestPosts(10)).rejects.toThrow('503');
    });

    it('throws when the source does not return a list', async () => {
      // WordPress answers an object ({ code, message }) on some errors with a 200
      // behind certain caches: it must not be handed to the parser as "posts".
      mockFetch.mockResolvedValue(Response.json({ code: 'rest_error' }));

      await expect(fetchLatestPosts(10)).rejects.toThrow('list of posts');
    });
  });

  // ─────────────────────────────────────────────
  describe('downloadAudio', () => {
    it('returns the bytes and the normalised MIME type', async () => {
      const bytes = new Uint8Array([0xff, 0xf3, 0x84, 0x00, 0x01]);
      mockFetch.mockResolvedValue(audioResponse(bytes, { 'content-type': 'Audio/MPEG; charset=binary' }));

      const audio = await downloadAudio(AUDIO_URL);

      expect(audio.mimeType).toBe('audio/mpeg');
      expect(Buffer.isBuffer(audio.data)).toBe(true);
      expect([...audio.data]).toEqual([...bytes]);
    });

    it('refuses redirects, so a valid URL cannot lead to another host', async () => {
      mockFetch.mockResolvedValue(audioResponse(new Uint8Array([1])));

      await downloadAudio(AUDIO_URL);

      expect(mockFetch.mock.calls[0][1].redirect).toBe('error');
    });

    it.each([
      ['another host', 'https://evil.test/a.mp3'],
      ['plain http', 'http://holaquepasa.com/a.mp3'],
      ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
    ])('refuses %s WITHOUT making any request', async (_label, url) => {
      await expect(downloadAudio(url)).rejects.toThrow('not an https URL');
      // The important part: the check happens before the network call.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws on an error status', async () => {
      mockFetch.mockResolvedValue(new Response('gone', { status: 404 }));

      await expect(downloadAudio(AUDIO_URL)).rejects.toThrow('404');
    });

    it.each([
      ['text/html'],
      ['application/octet-stream'],
      // A header that starts like an audio type but smuggles something else: this
      // value is later sent back as OUR Content-Type header.
      ['audio/mpeg\r\nX-Injected: 1'],
    ])('refuses the content type %p', async (contentType) => {
      // Headers() rejects a raw CR/LF, so the response is stubbed for this case.
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
        body: new Response(new Uint8Array([1])).body,
      });

      await expect(downloadAudio(AUDIO_URL)).rejects.toThrow('not an audio file');
    });

    it('refuses a file whose declared size is over the limit, before reading it', async () => {
      const response = audioResponse(new Uint8Array([1]), {
        'content-length': String(MAX_AUDIO_BYTES + 1),
      });
      mockFetch.mockResolvedValue(response);

      await expect(downloadAudio(AUDIO_URL)).rejects.toThrow('too large');
      // The body was never consumed.
      expect(response.bodyUsed).toBe(false);
    });

    it('stops reading a file that is over the limit even with no Content-Length', async () => {
      // No content-length header here: only the check made while reading can catch it.
      const tooBig = new Uint8Array(MAX_AUDIO_BYTES + 1);
      mockFetch.mockResolvedValue(audioResponse(tooBig));

      await expect(downloadAudio(AUDIO_URL)).rejects.toThrow('too large');
    });

    it('accepts a file exactly at the limit', async () => {
      mockFetch.mockResolvedValue(audioResponse(new Uint8Array(MAX_AUDIO_BYTES)));

      const audio = await downloadAudio(AUDIO_URL);

      expect(audio.data.length).toBe(MAX_AUDIO_BYTES);
    });

    it('refuses an empty file', async () => {
      mockFetch.mockResolvedValue(audioResponse(new Uint8Array(0)));

      await expect(downloadAudio(AUDIO_URL)).rejects.toThrow('empty');
    });
  });
});
