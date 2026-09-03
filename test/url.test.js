import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFeishuLink } from '../src/url.js';

test('parses docx links', () => {
  assert.deepEqual(parseFeishuLink('https://acme.feishu.cn/docx/Abc123XyZ890'), {
    type: 'docx',
    token: 'Abc123XyZ890',
    host: 'acme.feishu.cn',
  });
});

test('ignores query string and hash', () => {
  const parsed = parseFeishuLink('https://acme.feishu.cn/docx/Abc123XyZ890?from=share#heading');
  assert.equal(parsed.type, 'docx');
  assert.equal(parsed.token, 'Abc123XyZ890');
});

test('parses the other document types', () => {
  assert.equal(parseFeishuLink('https://acme.feishu.cn/docs/Abc123XyZ890').type, 'doc');
  assert.equal(parseFeishuLink('https://acme.feishu.cn/sheets/Abc123XyZ890').type, 'sheet');
  assert.equal(parseFeishuLink('https://acme.feishu.cn/base/Abc123XyZ890').type, 'bitable');
  assert.equal(parseFeishuLink('https://acme.feishu.cn/wiki/Abc123XyZ890').type, 'wiki');
  assert.equal(parseFeishuLink('https://acme.feishu.cn/file/Abc123XyZ890').type, 'file');
});

test('parses folder and wiki space links', () => {
  assert.deepEqual(parseFeishuLink('https://acme.feishu.cn/drive/folder/Fld123XyZ890'), {
    type: 'folder',
    token: 'Fld123XyZ890',
    host: 'acme.feishu.cn',
  });
  assert.equal(parseFeishuLink('https://acme.feishu.cn/wiki/space/7123456789').type, 'wiki_space');
});

test('supports Lark hosts', () => {
  assert.equal(parseFeishuLink('https://acme.larksuite.com/docx/Abc123XyZ890').type, 'docx');
  assert.equal(parseFeishuLink('https://acme.larkoffice.com/docx/Abc123XyZ890').type, 'docx');
});

test('accepts a bare token', () => {
  assert.deepEqual(parseFeishuLink('Abc123XyZ890'), {
    type: 'unknown',
    token: 'Abc123XyZ890',
    host: null,
  });
});

test('rejects non-Feishu hosts and unparseable links', () => {
  assert.throws(() => parseFeishuLink('https://example.com/docx/Abc123XyZ890'), /Not a Feishu/);
  assert.throws(() => parseFeishuLink('https://acme.feishu.cn/'), /Could not find a document token/);
  assert.throws(() => parseFeishuLink(''), /required/);
  assert.throws(() => parseFeishuLink('not a link'), /Not a Feishu link/);
});

test('is not fooled by a lookalike host', () => {
  assert.throws(() => parseFeishuLink('https://feishu.cn.evil.com/docx/Abc123XyZ890'), /Not a Feishu/);
});
