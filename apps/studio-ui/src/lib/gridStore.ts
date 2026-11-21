/**
 * IndexedDB storage for imported terrain grids.
 *
 * A native 4097² heightmap or a mask set is tens of megabytes once base64
 * encoded, far beyond localStorage. Grids are keyed by project id and restored
 * before autosave can overwrite them. The draft itself stays in localStorage so
 * it remains small and synchronous to load.
 */

import type { TerrainHeightImport, TerrainMaskImport } from "../wizard/types";

export interface StoredTerrainGrids {
  heightmap?: TerrainHeightImport;
  masks: TerrainMaskImport[];
  savedAt: string;
}

interface StoredGridsRecord extends StoredTerrainGrids {
  projectId: string;
}

const DB_NAME = "koba-grids";
const STORE = "terrain";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "projectId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Grid store unavailable"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Grid store failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Grid store aborted"));
  });
}

/**
 * Writes both grids as one record. Returns false when IndexedDB rejects the
 * write so the caller can report a partial autosave instead of claiming the
 * grids are durable.
 */
export async function writeTerrainGrids(
  projectId: string,
  heightmap: TerrainHeightImport | undefined,
  masks: TerrainMaskImport[],
): Promise<boolean> {
  try {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put({
        projectId,
        heightmap,
        masks,
        savedAt: new Date().toISOString(),
      } satisfies StoredGridsRecord);
      await transactionDone(transaction);
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export async function clearTerrainGrids(projectId: string): Promise<boolean> {
  try {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(projectId);
      await transactionDone(transaction);
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export async function readTerrainGrids(projectId: string): Promise<StoredTerrainGrids | null> {
  try {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(projectId) as IDBRequest<
        StoredGridsRecord | undefined
      >;
      const record = await new Promise<StoredGridsRecord | undefined>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Grid store failed"));
      });
      if (!record || !Array.isArray(record.masks)) return null;
      return { heightmap: record.heightmap, masks: record.masks, savedAt: record.savedAt };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
