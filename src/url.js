/**
 * Parsing of Feishu / Lark share links.
 *
 * Supported link shapes (query string and hash are ignored):
 *   https://<tenant>.feishu.cn/docx/<token>          -> { type: 'docx' }
 *   https://<tenant>.feishu.cn/docs/<token>          -> { type: 'doc' }  (legacy doc)
 *   https://<tenant>.feishu.cn/sheets/<token>        -> { type: 'sheet' }
 *   https://<tenant>.feishu.cn/base/<token>          -> { type: 'bitable' }
 *   https://<tenant>.feishu.cn/wiki/<token>          -> { type: 'wiki' } (needs a second call)
 *   https://<tenant>.feishu.cn/drive/folder/<token>  -> { type: 'folder' }
 *   https://<tenant>.feishu.cn/file/<token>          -> { type: 'file' }
 *
 * A bare token is also accepted and reported as { type: 'unknown' } so that callers
 * can ask for the document type explicitly.
 */

const PATH_TYPES = new Map([
  ['docx', 'docx'],
  ['docs', 'doc'],
  ['doc', 'doc'],
  ['sheets', 'sheet'],
  ['base', 'bitable'],
  ['wiki', 'wiki'],
  ['file', 'file'],
]);

const TOKEN_PATTERN = /^[A-Za-z0-9]{10,64}$/;

/**
 * @param {string} link a Feishu share link, or a bare document token
 * @returns {{ type: string, token: string, host: string | null }}
 */
export function parseFeishuLink(link) {
  if (typeof link !== 'string' || link.trim() === '') {
    throw new Error('A Feishu link (or document token) is required.');
  }

  const raw = link.trim();

  if (!/^https?:\/\//i.test(raw)) {
    if (TOKEN_PATTERN.test(raw)) {
      return { type: 'unknown', token: raw, host: null };
    }
    throw new Error(`Not a Feishu link or document token: ${raw}`);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }

  if (!/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/i.test(url.hostname)) {
    throw new Error(`Not a Feishu/Lark host: ${url.hostname}`);
  }

  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // /drive/folder/<token>
  if (segments[0] === 'drive' && segments[1] === 'folder' && segments[2]) {
    return { type: 'folder', token: segments[2], host: url.hostname };
  }

  // /wiki/space/<id> points at a space, not a single document.
  if (segments[0] === 'wiki' && segments[1] === 'space' && segments[2]) {
    return { type: 'wiki_space', token: segments[2], host: url.hostname };
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    const type = PATH_TYPES.get(segments[i]);
    const token = segments[i + 1];
    if (type && TOKEN_PATTERN.test(token)) {
      return { type, token, host: url.hostname };
    }
  }

  throw new Error(
    `Could not find a document token in the link: ${raw}\n` +
      'Supported paths: /docx/, /docs/, /sheets/, /base/, /wiki/, /file/, /drive/folder/.',
  );
}
