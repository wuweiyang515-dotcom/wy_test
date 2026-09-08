/**
 * Document-level operations: resolve a link to a concrete document, read it,
 * append content to it and create new documents.
 */

import { FeishuClient, FeishuError } from './client.js';
import { parseFeishuLink } from './url.js';

/** The docx API accepts at most 50 child blocks per create/delete call. */
const MAX_CHILDREN_PER_CALL = 50;

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

/**
 * Build docx text blocks (block_type 2 = paragraph) from plain text lines.
 *
 * Blank lines still need a `text_run`: the API rejects an empty `elements`
 * array with `invalid param`.
 */
function textBlocks(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => ({
    block_type: 2,
    text: {
      elements: [{ text_run: { content: line } }],
      style: {},
    },
  }));
}

/**
 * Append plain text to a docx document, as one paragraph per line.
 *
 * The API accepts at most 50 children per call, so longer content is sent in
 * successive batches.
 *
 * @param {string} [parentBlockId] defaults to the document root block
 */
export async function appendText(client, target, text, parentBlockId) {
  assertDocx(target, 'append content');
  const parent = parentBlockId || target.token; // the root block id equals the document id
  const blocks = textBlocks(text);
  const created = [];

  for (let offset = 0; offset < blocks.length; offset += MAX_CHILDREN_PER_CALL) {
    const batch = blocks.slice(offset, offset + MAX_CHILDREN_PER_CALL);
    const data = await client.request(
      `/open-apis/docx/v1/documents/${target.token}/blocks/${parent}/children`,
      { method: 'POST', body: { children: batch, index: -1 } },
    );
    created.push(...(data.children ?? []));
  }

  return created;
}

/**
 * Delete every child of a docx block (defaults to the document root), leaving
 * the document empty but preserving its title.
 *
 * @param {string} [parentBlockId] defaults to the document root block
 * @returns {Promise<number>} how many blocks were removed
 */
export async function deleteChildren(client, target, parentBlockId) {
  assertDocx(target, 'delete content');
  const parent = parentBlockId || target.token;
  const blocks = await listBlocks(client, target);
  const root = blocks.find((block) => block.block_id === parent);
  const count = root?.children?.length ?? 0;

  // Delete from the end so the indexes of the not-yet-deleted blocks stay valid.
  for (let end = count; end > 0; end -= MAX_CHILDREN_PER_CALL) {
    const start = Math.max(0, end - MAX_CHILDREN_PER_CALL);
    await client.request(
      `/open-apis/docx/v1/documents/${target.token}/blocks/${parent}/children/batch_delete`,
      { method: 'DELETE', body: { start_index: start, end_index: end } },
    );
  }
  return count;
}

/**
 * Replace the whole content of a docx document with plain text.
 *
 * @returns {Promise<{ deleted: number, created: number }>}
 */
export async function replaceContent(client, target, text, parentBlockId) {
  const deleted = await deleteChildren(client, target, parentBlockId);
  const children = await appendText(client, target, text, parentBlockId);
  return { deleted, created: children.length };
}

/** Replace the text of a single existing block. */
export async function updateBlockText(client, target, blockId, text) {
  assertDocx(target, 'update a block');
  return client.request(`/open-apis/docx/v1/documents/${target.token}/blocks/${blockId}`, {
    method: 'PATCH',
    body: {
      update_text_elements: {
        elements: [{ text_run: { content: text } }],
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
