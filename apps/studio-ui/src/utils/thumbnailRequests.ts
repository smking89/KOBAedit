/**
 * Shared thumbnail request queue.
 *
 * Cards enter through an IntersectionObserver, so only visible (or nearly
 * visible) cards ask for GPU work. A hash-keyed in-flight map collapses
 * duplicate requests from the drawer and the skin picker, and a small LRU of
 * generated data URLs keeps scrolling back over a page allocation-free.
 */
const MAX_CACHED = 96;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function remember(key: string, value: string): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function cachedThumbnailUrl(key: string): string | undefined {
  return cache.get(key);
}

export function requestThumbnail(
  key: string,
  loader: () => Promise<string | null>,
  options: { retries?: number } = {},
): Promise<string | null> {
  const cached = cache.get(key);
  if (cached) {
    // Refresh LRU position on a hit.
    remember(key, cached);
    return Promise.resolve(cached);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const retries = options.retries ?? 1;
  const task = (async () => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await loader();
        if (result) {
          remember(key, result);
          return result;
        }
      } catch {
        // A placeholder plus one retry is preferable to a broken image.
      }
      if (attempt < retries) await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
    return null;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

/** Drop cached URLs for a filter change; in-flight work still resolves safely. */
export function clearThumbnailCache(): void {
  cache.clear();
}
