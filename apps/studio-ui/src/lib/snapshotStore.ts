/**
 * Browser fallback for the bird's-eye gallery.
 *
 * The desktop shell stores PNGs on disk. The browser preview has no
 * filesystem, so it keeps captures in IndexedDB: a 2048 px overview is several
 * megabytes and would exhaust localStorage after one or two versions.
 */

export interface SnapshotView {
  id: string;
  label: string;
  dataUrl: string;
  createdAt: string;
}

interface StoredSnapshot extends SnapshotView {
  projectId: string;
}

const DB_NAME = "koba-snapshots";
const STORE = "shots";
const MAX_BROWSER_SNAPSHOTS = 24;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("projectId", "projectId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Snapshot store unavailable"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Snapshot store failed"));
  });
}

async function allForProject(projectId: string): Promise<StoredSnapshot[]> {
  const db = await openDatabase();
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const rows = await requestResult<StoredSnapshot[]>(
      store.index("projectId").getAll(projectId) as IDBRequest<StoredSnapshot[]>,
    );
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

export async function readLocalSnapshots(projectId: string): Promise<SnapshotView[]> {
  try {
    const rows = await allForProject(projectId);
    return rows.map(({ id, label, dataUrl, createdAt }) => ({ id, label, dataUrl, createdAt }));
  } catch {
    return [];
  }
}

export async function writeLocalSnapshot(
  projectId: string,
  snapshot: SnapshotView,
): Promise<SnapshotView[]> {
  try {
    const db = await openDatabase();
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      await requestResult(store.put({ ...snapshot, projectId }));
      const rows = await allForProject(projectId);
      const stale = rows.slice(MAX_BROWSER_SNAPSHOTS);
      if (stale.length > 0) {
        const transaction = db.transaction(STORE, "readwrite");
        const cleanup = transaction.objectStore(STORE);
        for (const extra of stale) cleanup.delete(extra.id);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // IndexedDB can be unavailable in a locked-down webview; the capture is
    // still shown from React state for this session.
  }
  return [snapshot, ...(await readLocalSnapshots(projectId)).filter((item) => item.id !== snapshot.id)];
}

export async function deleteLocalSnapshot(projectId: string, id: string): Promise<SnapshotView[]> {
  try {
    const db = await openDatabase();
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      await requestResult(store.delete(id));
    } finally {
      db.close();
    }
  } catch {
    // The in-memory list still updates.
  }
  return readLocalSnapshots(projectId);
}
