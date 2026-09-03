/**
 * Document-level operations: resolve a link to a concrete document, read it,
 * append content to it and create new documents.
 */

import { FeishuClient, FeishuError } from './client.js';
import { parseFeishuLink } from './url.js';

/**
 * Resolve a share link to a concrete object. Wiki links are resolved to the
 * underlying object (`obj_type` / `obj_token`) with one extra API call.
 *
 * @returns {Promise<{ type: string, token: string, wikiToken?: string }>}
 */
export async function resolveLink(client, link) {
  const parsed = parseFeishuLink(link);

  if (parsed.type === 'wiki') {
    const data = await client.request('/open-apis/wiki/v2/spaces/get_node', {
      query: { token: parsed.token, obj_type: 'wiki' },
    });
    const node = data.node;
    if (!node) {
      throw new FeishuError(`Wiki node not found for token ${parsed.token}.`);
    }
    return { type: node.obj_type, token: node.obj_token, wikiToken: parsed.token };
  }

  return { type: parsed.type, token: parsed.token };
}

function assertDocx(target, action) {
  if (target.type !== 'docx') {
    throw new FeishuError(
      `Cannot ${action}: the link points at a "${target.type}" object, only "docx" documents are supported.`,
    );
  }
}

/** Fetch the title of any supported object, used by the connectivity self-test. */
export async function getTitle(client, target) {
  switch (target.type) {
    case 'docx': {
      const data = await client.request(`/open-apis/docx/v1/documents/${target.token}`);
      return data.document?.title ?? '';
    }
    case 'sheet': {
      const data = await client.request(`/open-apis/sheets/v3/spreadsheets/${target.token}`);
      return data.spreadsheet?.title ?? '';
    }
    case 'bitable': {
      const data = await client.request(`/open-apis/bitable/v1/apps/${target.token}`);
      return data.app?.name ?? '';
    }
    default: {
      const data = await client.request('/open-apis/drive/v1/metas/batch_query', {
        method: 'POST',
        body: { request_docs: [{ doc_token: target.token, doc_type: target.type }], with_url: false },
      });
      return data.metas?.[0]?.title ?? '';
    }
  }
}

/** Plain-text content of a docx document. */
export async function readRawContent(client, target) {
  assertDocx(target, 'read content');
  const data = await client.request(`/open-apis/docx/v1/documents/${target.token}/raw_content`, {
    query: { lang: 0 },
  });
  return data.content ?? '';
}

/** All blocks of a docx document, following pagination. */
export async function listBlocks(client, target) {
  assertDocx(target, 'list blocks');
  const blocks = [];
  let pageToken;
  do {
    const data = await client.request(`/open-apis/docx/v1/documents/${target.token}/blocks`, {
      query: { page_size: 500, page_token: pageToken, document_revision_id: -1 },
    });
    blocks.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return blocks;
}

/** Build docx text blocks (block_type 2 = paragraph) from plain text lines. */
function textBlocks(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => ({
    block_type: 2,
    text: {
      elements: line === '' ? [] : [{ text_run: { content: line } }],
      style: {},
    },
  }));
}

/**
 * Append plain text to a docx document, as one paragraph per line.
 *
 * @param {string} [parentBlockId] defaults to the document root block
 */
export async function appendText(client, target, text, parentBlockId) {
  assertDocx(target, 'append content');
  const parent = parentBlockId || target.token; // the root block id equals the document id
  const data = await client.request(
    `/open-apis/docx/v1/documents/${target.token}/blocks/${parent}/children`,
    { method: 'POST', body: { children: textBlocks(text), index: -1 } },
  );
  return data.children ?? [];
}

/** Replace the text of a single existing block. */
export async function updateBlockText(client, target, blockId, text) {
  assertDocx(target, 'update a block');
  return client.request(`/open-apis/docx/v1/documents/${target.token}/blocks/${blockId}`, {
    method: 'PATCH',
    body: {
      update_text_elements: {
        elements: text === '' ? [] : [{ text_run: { content: text } }],
      },
    },
  });
}

/**
 * Create a new docx document.
 *
 * @param {string} [folderToken] target folder; empty means the app's root folder
 */
export async function createDocument(client, title, folderToken) {
  const data = await client.request('/open-apis/docx/v1/documents', {
    method: 'POST',
    body: { title, ...(folderToken ? { folder_token: folderToken } : {}) },
  });
  return data.document ?? {};
}

export { FeishuClient, FeishuError, parseFeishuLink };
