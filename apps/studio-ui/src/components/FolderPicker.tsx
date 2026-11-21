import { useEffect, useState } from "react";

import { listDirectories, type DirectoryListing } from "../lib/ipc";

/**
 * In-app folder browser. The native GTK dialog can black out WebKitGTK while
 * it owns the window, so asset roots are chosen without leaving the webview.
 */
export function FolderPicker({
  open,
  startIn,
  onClose,
  onPick,
}: {
  open: boolean;
  /** Detected asset folder to open at; without it the picker starts at Desktop. */
  startIn?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const browse = (target?: string | null) => {
    setLoading(true);
    setError(null);
    listDirectories(target)
      .then((next) => {
        setListing(next);
        setPath(next.path);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) browse(startIn ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startIn]);

  if (!open) return null;
  return (
    <div className="folder-picker-backdrop" role="presentation" onClick={onClose}>
      <section
        className="folder-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Choose asset folder"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="asset-eyebrow">Asset roots</p>
            <h2>Choose a folder</h2>
          </div>
          <button type="button" className="asset-refresh" onClick={onClose}>
            Close
          </button>
        </header>
        <form
          className="folder-picker-path"
          onSubmit={(event) => {
            event.preventDefault();
            browse(path);
          }}
        >
          <input value={path} onChange={(event) => setPath(event.target.value)} aria-label="Folder path" />
          <button type="submit" className="asset-refresh" disabled={loading}>
            Go
          </button>
        </form>
        {error && <p className="asset-state is-error">{error}</p>}
        {listing && (
          <>
            <div className="folder-picker-up">
              <button
                type="button"
                className="asset-refresh"
                disabled={!listing.parent}
                onClick={() => browse(listing.parent)}
              >
                Up
              </button>
              <code>{listing.path}</code>
            </div>
            <ul className="folder-picker-list">
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" onClick={() => browse(entry.path)}>
                    <span aria-hidden="true">▸</span> {entry.name}
                  </button>
                </li>
              ))}
              {!listing.entries.length && !loading && <li className="is-empty">No subfolders here.</li>}
            </ul>
            <footer>
              <button type="button" className="launcher-preset" onClick={() => onPick(listing.path)}>
                <strong>Use this folder</strong>
                <span>{listing.path}</span>
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
