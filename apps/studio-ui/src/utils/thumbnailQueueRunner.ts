/**
 * Work through a list with a fixed number of workers.
 *
 * The assets drawer renders previews for the page it has loaded with this: the
 * browser stops delivering IntersectionObserver callbacks for that scroll
 * container, so a lazy trigger is not dependable, and queueing the whole
 * 20k catalogue at once is not acceptable either.
 */
export async function runThumbnailQueue<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  options: { concurrency?: number; cancelled?: () => boolean } = {},
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const cancelled = options.cancelled ?? (() => false);
  let cursor = 0;

  const next = (): T | null => {
    if (cancelled() || cursor >= items.length) return null;
    const item = items[cursor];
    cursor += 1;
    return item;
  };

  const run = async (): Promise<void> => {
    for (let item = next(); item !== null; item = next()) {
      try {
        await worker(item);
      } catch {
        // One unreadable asset must not stop the rest of the page.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}
