// The whole stored history of a REST session, newest page first.
//
// GET /api/sessions/{id}/messages answers the newest 500 rows by default (Hermes caps a page at
// 500) with a `pagination` block and no total. A long chat opened in the panel showed only those
// 500, silently. This walks back with `order=latest` (pages counted from the newest, each one in
// chronological order) until a page comes back short. A gateway that does not page (no
// `pagination` block, or a page that is not the one asked for) keeps its single answer.

export const HISTORY_PAGE_ROWS = 500;
// 20 pages is 10,000 rows. Past that the newest rows are kept and `truncated` says so.
export const HISTORY_MAX_PAGES = 20;

function pageRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function answeredPage(payload, { offset, order }) {
  const pagination = payload?.pagination;
  return Boolean(pagination && typeof pagination === 'object')
    && String(pagination.order || '') === order
    && Number(pagination.offset) === offset;
}

/**
 * @param {(query: string) => Promise<object>} fetchPage - resolves a page's JSON payload for the
 *   given query string ('' for the default page); rejects on an HTTP error.
 * @returns {Promise<{ payload: object, rows: object[], truncated: boolean }>} the first answer
 *   (its `session` and the like), every row oldest first, and whether the cap cut older rows off.
 */
export async function fetchSessionHistoryPages(fetchPage, { pageSize = HISTORY_PAGE_ROWS, maxPages = HISTORY_MAX_PAGES } = {}) {
  const payload = await fetchPage('');
  const newest = pageRows(payload);
  if (newest.length < pageSize || !answeredPage(payload, { offset: 0, order: 'latest' })) {
    return { payload, rows: newest, truncated: false };
  }
  const pages = [newest];
  let truncated = true;
  for (let page = 1; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const older = await fetchPage(`order=latest&limit=${pageSize}&offset=${offset}`);
    if (!answeredPage(older, { offset, order: 'latest' })) {
      truncated = false;
      break;
    }
    const rows = pageRows(older);
    pages.unshift(rows);
    if (rows.length < pageSize) {
      truncated = false;
      break;
    }
  }
  // A row appended while the pages were read shifts the next page by one: keep each id once.
  const seen = new Set();
  const rows = pages.flat().filter((row) => {
    const id = row?.id;
    if (id === undefined || id === null || id === '') return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { payload, rows, truncated };
}
