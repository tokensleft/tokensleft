import { renderSingleAccount } from './provider-render.js';

// Shared pieces of the provider contract (see lib/tui.js runDashboard for the
// full shape). Provider modules own authentication and quota mapping; the
// snapshot envelope, header status, and alert extraction are the same for all
// of them and live here.

// Failure snapshot: the dashboard reads `ok`, `status`, and `error`; `items`
// must always be an array so renderers never special-case a missing list.
export function errorSnapshot(status, error, startedAt, extra = {}) {
  return {
    ok: false,
    status,
    error,
    ms: Date.now() - startedAt,
    items: [],
    ...extra,
  };
}

// Threshold alerts and reset detection only make sense for percentage
// windows; info lines and empty placeholders carry no percent.
export function usageAlertItems(items, labelPrefix = '') {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item.kind !== 'info' && item.kind !== 'empty')
    .map((item) => ({
      key: item.key,
      label: [labelPrefix, item.label].filter(Boolean).join(' '),
      percent: item.percent,
      resetAt: item.resetAt,
    }));
}

export function singleAccountHeaderStatus(snapshot) {
  return { ok: !!snapshot.ok, text: snapshot.ok ? 'OK' : String(snapshot.status || 'ERR') };
}

// Header status for providers whose snapshot carries one result per account.
export function multiAccountHeaderStatus(snapshot, { countable = () => true } = {}) {
  if (snapshot.fatal) {
    return { ok: false, text: 'ERR' };
  }

  const counted = snapshot.results.filter(countable);
  const okCount = counted.filter((result) => result.ok).length;
  return { ok: okCount === counted.length, text: `${okCount}/${counted.length} OK` };
}

// Providers with a single account share one dashboard contract: they render
// through renderSingleAccount, report OK or the failure status in the header,
// and alert on their usage items. The module keeps only `fetch` and its
// local-usage table options.
export function createSingleAccountProvider({ id, title, refreshMs, fetch, localOpts }) {
  return {
    id,
    title,
    refreshMs,
    fetch,

    render(snapshot, width, mode = 'detail') {
      return renderSingleAccount(snapshot, width, mode, id, localOpts);
    },

    headerStatus: singleAccountHeaderStatus,

    alertItems(snapshot) {
      return usageAlertItems(snapshot.items);
    },
  };
}
