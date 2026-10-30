/** Preserve other tabs' filters without importing their UI or chart bundles. */
export function setUrlParams(values: Record<string, string | null>) {
  const p = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(values)) {
    if (value) p.set(key, value); else p.delete(key);
  }
  const qs = p.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
}
