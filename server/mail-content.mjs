// Turns Microsoft Graph message bodies into readable text and a clean link list.

const NAMED_ENTITIES = new Map(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    zwnj: '',
    zwj: '',
    shy: '',
    lrm: '',
    rlm: '',
    copy: '©',
    reg: '®',
    trade: '™',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    bull: '•',
    middot: '·',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    euro: '€',
    pound: '£',
    yen: '¥',
    cent: '¢',
    deg: '°',
    times: '×',
    divide: '÷',
    rarr: '→',
    larr: '←'
  })
);

// Zero-width and filler characters that newsletters use to pad preview text.
const INVISIBLE_CHARACTERS =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]/g;

const BLOCK_TAGS =
  /<\/?(?:p|div|tr|li|ul|ol|dl|dt|dd|h[1-6]|table|thead|tbody|tfoot|section|article|header|footer|nav|aside|main|blockquote|center|pre|hr|form|fieldset|address|figure|figcaption)\b[^>]*>/gi;

export function decodeHtmlEntities(value = '') {
  // Single pass, so "&amp;lt;" decodes to "&lt;" rather than "<".
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = isHex ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

export function cleanText(value = '') {
  return String(value)
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html = '') {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
    // Inline tags vanish without a space, so a code split across <span>s stays intact.
    .replace(/<[^>]*>/g, '');
  return cleanText(decodeHtmlEntities(text));
}

export function normalizeUrl(value = '', { trimPunctuation = false } = {}) {
  let cleaned = decodeHtmlEntities(String(value)).trim();
  if (trimPunctuation) {
    cleaned = cleaned.replace(/[)\].,;:!?'"，。；：！？、）】》」』]+$/u, '');
  }
  if (!/^https?:\/\//i.test(cleaned)) return null;
  try {
    return new URL(cleaned).href;
  } catch {
    return null;
  }
}

export function extractLinks(html, text) {
  const links = new Map();
  const add = (rawUrl, label, trimPunctuation = false) => {
    if (links.size >= 50) return;
    const url = normalizeUrl(rawUrl, { trimPunctuation });
    if (!url || links.has(url)) return;
    links.set(url, {
      url,
      host: new URL(url).hostname.replace(/^www\./, ''),
      label: label.slice(0, 140)
    });
  };

  for (const [, attributes, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    if (!href) continue;
    const alt = inner.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const label =
      htmlToText(inner).replace(/\s+/g, ' ') ||
      cleanText(decodeHtmlEntities(alt?.[1] ?? alt?.[2] ?? ''));
    add(href[1] ?? href[2] ?? href[3], label);
  }

  // Bare URLs are taken from the visible text only, so image sources,
  // stylesheets and xmlns declarations don't end up in the list.
  for (const [url] of text.matchAll(/https?:\/\/[^\s<>"'，。；、）】」』]+/gi)) {
    add(url, '', true);
  }

  return [...links.values()];
}
