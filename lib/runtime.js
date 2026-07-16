// `node:sqlite` exists only on newer Node releases (and can also be disabled
// with a runtime flag). Probe the capability instead of assuming it from the
// Node version so older runtimes can still use providers that do not need it.
export async function loadNodeSqlite(load = (specifier) => import(specifier)) {
  try {
    const sqlite = await load('node:sqlite');
    return typeof sqlite?.DatabaseSync === 'function' ? sqlite : null;
  } catch {
    return null;
  }
}
