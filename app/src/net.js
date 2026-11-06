// Download with progress. Used to warm the browser cache for big assets (engine WASM, lesson model) so the
// worker or dynamic import that needs them next reads them from cache, while the UI shows real progress.
/** fetch `url`, calling onProgress(loaded, total) as bytes arrive. `size` is a fallback when there is no Content-Length.
 *  With `keep`, resolves to a Blob of the body (so it can be used directly, without a second request). */
export async function fetchProgress(url, onProgress, size = 0, keep = false) {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const total = +res.headers.get('content-length') || size;
  if (!res.body || !res.body.getReader) { const b = await res.arrayBuffer(); onProgress?.(b.byteLength, b.byteLength); return keep ? new Blob([b]) : b.byteLength; }
  const reader = res.body.getReader(), parts = keep ? [] : null; let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength; parts?.push(value); onProgress?.(loaded, Math.max(total, loaded));
  }
  onProgress?.(loaded, loaded);
  return keep ? new Blob(parts) : loaded;
}
/** Slow or metered connection, or a low-memory device: defer optional downloads until they are needed. */
export const lowResource = () => {
  const c = navigator.connection;
  return !!(c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) || (navigator.deviceMemory !== undefined && navigator.deviceMemory < 2);
};
