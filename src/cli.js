#!/usr/bin/env node
/**
 * feishu - a thin CLI over the Feishu / Lark cloud document APIs.
 *
 * Usage:
 *   feishu check [<link>]
 *   feishu resolve <link>
 *   feishu read <link> [--blocks] [--json]
 *   feishu append <link> (--text <text> | --file <path>) [--parent <block_id>]
 *   feishu update <link> --block <block_id> (--text <text> | --file <path>)
 *   feishu create --title <title> [--folder <folder_token>] [--text <text> | --file <path>]
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import {
  FeishuClient,
  FeishuError,
  appendText,
  createDocument,
  getTitle,
  listBlocks,
  readRawContent,
  resolveLink,
  updateBlockText,
} from './docs.js';

const USAGE = `feishu - read, append to and create Feishu (Lark) cloud documents.

Commands:
  check [<link>]         Verify credentials and network access; with a link, also read its title.
  resolve <link>         Print the object type and token a link points at (wiki links are resolved).
  read <link>            Print the plain-text content of a docx document.
    --blocks             Print the block tree instead of plain text.
    --json               Print raw JSON.
  append <link>          Append text to a docx document (one paragraph per line).
    --text <text>        Text to append.
    --file <path>        Read the text from a file ("-" for stdin).
    --parent <block_id>  Parent block to append to (defaults to the document root).
  update <link>          Replace the text of one block.
    --block <block_id>   Block to update (required).
    --text/--file        New text.
  create                 Create a new docx document.
    --title <title>      Document title (required).
    --folder <token>     Target folder token, or a folder link.
    --text/--file        Optional initial content.

Environment:
  FEISHU_APP_ID, FEISHU_APP_SECRET   Credentials of a Feishu custom app (required).
  FEISHU_DOMAIN                      API base, defaults to https://open.feishu.cn
                                     (use https://open.larksuite.com for Lark).
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s);
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags[name] = argv[i + 1];
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function resolveText(flags, { required = true } = {}) {
  if (typeof flags.text === 'string') return flags.text;
  if (typeof flags.file === 'string') {
    return flags.file === '-' ? readStdin() : readFileSync(flags.file, 'utf8');
  }
  if (required) throw new FeishuError('Provide the content with --text or --file.');
  return null;
}

function requireLink(positional) {
  const link = positional[0];
  if (!link) throw new FeishuError('A Feishu link (or document token) is required.');
  return link;
}

async function commandCheck(client, positional) {
  await client.getTenantAccessToken();
  console.log(`OK: obtained a tenant_access_token from ${client.domain}`);

  const link = positional[0];
  if (!link) {
    console.log('Pass a document link to also verify document permissions.');
    return;
  }

  const target = await resolveLink(client, link);
  const title = await getTitle(client, target);
  console.log(`OK: ${target.type} ${target.token} -> "${title}"`);
}

async function commandResolve(client, positional) {
  const target = await resolveLink(client, requireLink(positional));
  console.log(JSON.stringify(target, null, 2));
}

async function commandRead(client, positional, flags) {
  const target = await resolveLink(client, requireLink(positional));
  if (flags.blocks) {
    const blocks = await listBlocks(client, target);
    console.log(JSON.stringify(blocks, null, 2));
    return;
  }
  const content = await readRawContent(client, target);
  if (flags.json) {
    console.log(JSON.stringify({ ...target, content }, null, 2));
    return;
  }
  console.log(content);
}

async function commandAppend(client, positional, flags) {
  const target = await resolveLink(client, requireLink(positional));
  const text = resolveText(flags);
  const children = await appendText(
    client,
    target,
    text,
    typeof flags.parent === 'string' ? flags.parent : undefined,
  );
  console.log(`Appended ${children.length} block(s) to ${target.token}.`);
}

async function commandUpdate(client, positional, flags) {
  if (typeof flags.block !== 'string') {
    throw new FeishuError('--block <block_id> is required (use `read --blocks` to find it).');
  }
  const target = await resolveLink(client, requireLink(positional));
  await updateBlockText(client, target, flags.block, resolveText(flags));
  console.log(`Updated block ${flags.block} in ${target.token}.`);
}

async function commandCreate(client, flags) {
  if (typeof flags.title !== 'string' || flags.title === '') {
    throw new FeishuError('--title <title> is required.');
  }

  let folderToken;
  if (typeof flags.folder === 'string' && flags.folder !== '') {
    folderToken = (await resolveLink(client, flags.folder)).token;
  }

  const document = await createDocument(client, flags.title, folderToken);
  const documentId = document.document_id;
  console.log(`Created document ${documentId} ("${flags.title}").`);

  const text = resolveText(flags, { required: false });
  if (text) {
    await appendText(client, { type: 'docx', token: documentId }, text);
    console.log('Initial content written.');
  }
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift();

  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }

  const client = new FeishuClient();

  switch (command) {
    case 'check':
      await commandCheck(client, positional);
      break;
    case 'resolve':
      await commandResolve(client, positional);
      break;
    case 'read':
      await commandRead(client, positional, flags);
      break;
    case 'append':
      await commandAppend(client, positional, flags);
      break;
    case 'update':
      await commandUpdate(client, positional, flags);
      break;
    case 'create':
      await commandCreate(client, flags);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof FeishuError ? error.message : error);
    process.exitCode = 1;
  });
