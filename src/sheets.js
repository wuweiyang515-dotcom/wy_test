/**
 * Spreadsheet operations: list the tabs of a spreadsheet and read cell values.
 *
 * Feishu exposes two generations of the sheets API. Tab metadata comes from
 * `sheets/v3` (`.../sheets/query`), while cell values still come from
 * `sheets/v2` (`.../values/<range>`), which is the only endpoint that returns
 * rendered values for a plain `A1:Z100` style range.
 */

import { FeishuError } from './client.js';

function assertSheet(target, action) {
  if (target.type !== 'sheet') {
    throw new FeishuError(
      `Cannot ${action}: the link points at a "${target.type}" object, not a spreadsheet.`,
    );
  }
}

/** All tabs of a spreadsheet: `{ sheetId, title, index, rowCount, columnCount }`. */
export async function listSheets(client, target) {
  assertSheet(target, 'list tabs');
  const data = await client.request(`/open-apis/sheets/v3/spreadsheets/${target.token}/sheets/query`);
  return (data.sheets ?? []).map((sheet) => ({
    sheetId: sheet.sheet_id,
    title: sheet.title,
    index: sheet.index,
    rowCount: sheet.grid_properties?.row_count,
    columnCount: sheet.grid_properties?.column_count,
  }));
}

/**
 * Find a tab by id or by title. Titles are matched case-insensitively after
 * trimming, so `--tab 点击分析` works regardless of surrounding whitespace.
 */
export async function findSheet(client, target, wanted) {
  const sheets = await listSheets(client, target);
  if (sheets.length === 0) {
    throw new FeishuError(`Spreadsheet ${target.token} has no tabs.`);
  }
  if (!wanted) return sheets[0];

  const needle = String(wanted).trim().toLowerCase();
  const found =
    sheets.find((sheet) => sheet.sheetId === wanted) ??
    sheets.find((sheet) => (sheet.title ?? '').trim().toLowerCase() === needle);
  if (!found) {
    const available = sheets.map((sheet) => `${sheet.title} (${sheet.sheetId})`).join(', ');
    throw new FeishuError(`Tab "${wanted}" not found. Available tabs: ${available}`);
  }
  return found;
}

/**
 * Convert a 1-based column index to its spreadsheet letter (1 -> A, 27 -> AA).
 *
 * @param {number} index
 */
export function columnLetter(index) {
  let rest = index;
  let letters = '';
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    rest = Math.floor((rest - remainder - 1) / 26);
  }
  return letters;
}

/**
 * Feishu returns each cell either as a scalar or as an array of rich-text
 * segments (links, mentions, formula results). Flatten everything to plain text
 * so the result can be compared and re-rendered easily.
 */
function cellToText(cell) {
  if (cell === null || cell === undefined) return '';
  if (Array.isArray(cell)) return cell.map(cellToText).join('');
  if (typeof cell === 'object') {
    return String(cell.text ?? cell.link ?? cell.name ?? cell.value ?? '');
  }
  return String(cell);
}

/** Largest number of cells the v2 values endpoint reliably returns in one call. */
const MAX_CELLS_PER_REQUEST = 50_000;

/**
 * Read a tab's cell values as a matrix of strings.
 *
 * Rows are fetched in chunks so that large tabs stay within the API's per-call
 * cell limit.
 *
 * @param {{ sheetId: string, rowCount?: number, columnCount?: number }} sheet
 * @param {{ maxRows?: number, maxColumns?: number }} [options]
 * @returns {Promise<string[][]>}
 */
export async function readSheetValues(client, target, sheet, options = {}) {
  assertSheet(target, 'read values');

  const totalColumns = Math.min(options.maxColumns ?? sheet.columnCount ?? 50, sheet.columnCount ?? 50);
  const totalRows = Math.min(options.maxRows ?? sheet.rowCount ?? 1000, sheet.rowCount ?? 1000);
  if (totalColumns < 1 || totalRows < 1) return [];

  const lastColumn = columnLetter(totalColumns);
  const rowsPerChunk = Math.max(1, Math.floor(MAX_CELLS_PER_REQUEST / totalColumns));

  const matrix = [];
  for (let startRow = 1; startRow <= totalRows; startRow += rowsPerChunk) {
    const endRow = Math.min(startRow + rowsPerChunk - 1, totalRows);
    const range = `${sheet.sheetId}!A${startRow}:${lastColumn}${endRow}`;
    const data = await client.request(
      `/open-apis/sheets/v2/spreadsheets/${target.token}/values/${encodeURIComponent(range)}`,
      { query: { valueRenderOption: 'ToString', dateTimeRenderOption: 'FormattedString' } },
    );
    const values = data.valueRange?.values ?? [];
    for (const row of values) {
      matrix.push(row.map(cellToText));
    }
    if (values.length < endRow - startRow + 1) break; // tab ended early
  }

  // Drop trailing rows that are entirely empty; Feishu pads ranges to the grid size.
  while (matrix.length > 0 && matrix[matrix.length - 1].every((cell) => cell === '')) {
    matrix.pop();
  }
  return matrix;
}

/**
 * Create a tab, or return the existing one when a tab with that title is
 * already present, so that writing a report twice does not pile up duplicates.
 *
 * @param {{ index?: number, rowCount?: number, columnCount?: number }} [options]
 */
export async function ensureSheet(client, target, title, options = {}) {
  assertSheet(target, 'create a tab');
  const existing = (await listSheets(client, target)).find(
    (sheet) => (sheet.title ?? '').trim() === String(title).trim(),
  );
  if (existing) return existing;

  const properties = { title };
  if (options.index !== undefined) properties.index = options.index;
  const data = await client.request(
    `/open-apis/sheets/v2/spreadsheets/${target.token}/sheets_batch_update`,
    { method: 'POST', body: { requests: [{ addSheet: { properties } }] } },
  );
  const created = data.replies?.[0]?.addSheet?.properties;
  if (!created?.sheetId) {
    throw new FeishuError(`Could not create the tab "${title}".`);
  }
  return {
    sheetId: created.sheetId,
    title: created.title ?? title,
    index: created.index,
    rowCount: created.rowCount,
    columnCount: created.columnCount,
  };
}

/** Grow a tab so that it can hold `rows` x `columns` cells before writing. */
async function ensureCapacity(client, target, sheet, rows, columns) {
  const requests = [];
  if (sheet.rowCount !== undefined && rows > sheet.rowCount) {
    requests.push({ dimension: { sheetId: sheet.sheetId, majorDimension: 'ROWS' }, length: rows - sheet.rowCount });
  }
  if (sheet.columnCount !== undefined && columns > sheet.columnCount) {
    requests.push({
      dimension: { sheetId: sheet.sheetId, majorDimension: 'COLUMNS' },
      length: columns - sheet.columnCount,
    });
  }
  for (const body of requests) {
    await client.request(`/open-apis/sheets/v2/spreadsheets/${target.token}/dimension_range`, {
      method: 'POST',
      body,
    });
  }
}

/** Remove every value currently present in a tab. */
export async function clearSheet(client, target, sheet) {
  assertSheet(target, 'clear a tab');
  const columns = sheet.columnCount ?? 20;
  const rows = sheet.rowCount ?? 200;
  if (rows < 1 || columns < 1) return;
  await client.request(`/open-apis/sheets/v2/spreadsheets/${target.token}/values_batch_update`, {
    method: 'POST',
    body: {
      valueRanges: [
        {
          range: `${sheet.sheetId}!A1:${columnLetter(columns)}${rows}`,
          values: Array.from({ length: rows }, () => Array.from({ length: columns }, () => '')),
        },
      ],
    },
  });
}

/**
 * Write a matrix of values starting at A1, in chunks to stay within the API's
 * per-call cell limit. Rows may be ragged; they are padded to the widest row.
 *
 * @param {(string | number | null)[][]} matrix
 */
export async function writeSheetValues(client, target, sheet, matrix) {
  assertSheet(target, 'write values');
  if (matrix.length === 0) return 0;

  const columns = Math.max(...matrix.map((row) => row.length), 1);
  const padded = matrix.map((row) => {
    const copy = row.map((cell) => (cell === undefined || cell === null ? '' : cell));
    while (copy.length < columns) copy.push('');
    return copy;
  });

  await ensureCapacity(client, target, sheet, padded.length, columns);

  const lastColumn = columnLetter(columns);
  const rowsPerChunk = Math.max(1, Math.floor(MAX_CELLS_PER_REQUEST / columns));
  for (let start = 0; start < padded.length; start += rowsPerChunk) {
    const chunk = padded.slice(start, start + rowsPerChunk);
    const firstRow = start + 1;
    const lastRow = start + chunk.length;
    await client.request(`/open-apis/sheets/v2/spreadsheets/${target.token}/values_batch_update`, {
      method: 'POST',
      body: {
        valueRanges: [{ range: `${sheet.sheetId}!A${firstRow}:${lastColumn}${lastRow}`, values: chunk }],
      },
    });
  }
  return padded.length;
}
