import type { LocalAssetStatus } from "../lib/ipc";

const REQUIRED: { key: string; label: string }[] = [
  { key: "mesh", label: "Mesh (.glb)" },
  { key: "texture2d", label: "Texture2D" },
  { key: "sprite", label: "Sprite" },
];

export function AssetSetupCard({
  open,
  status,
  busy,
  onBrowse,
  onRescan,
  onPick,
  onContinue,
  onClose,
}: {
  open: boolean;
  status: LocalAssetStatus | null;
  busy: boolean;
  onBrowse: () => void;
  onRescan: () => void;
  onPick: (path: string) => void;
  onContinue: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const counts = status?.counts ?? {};
  const missing = REQUIRED.filter((item) => !counts[item.key]);
  const total = REQUIRED.reduce((sum, item) => sum + (counts[item.key] ?? 0), 0);

  return (
    <div className="launcher-backdrop" role="dialog" aria-modal="true" aria-label="Asset setup">
      <div className="launcher asset-setup">
        <div className="launcher-banner">
          <img src="/branding/koba-studios-wordmark.png" alt="KOBA Studios" />
          <div>
            <p>LOCAL ASSET SETUP</p>
            <strong>{total ? "Some asset folders are missing" : "No local Rust assets found"}</strong>
          </div>
        </div>
        <div className="asset-setup-body">
          <p className="asset-setup-lead">
            KOBA Studios never ships Rust game files. Point it at your unpacked KOBAedit folders or a
            Steam install; files stay where they are and only metadata is indexed.
          </p>
          <ul className="asset-setup-list">
            {REQUIRED.map((item) => {
              const count = counts[item.key] ?? 0;
              return (
                <li key={item.key} className={count ? "is-found" : "is-missing"}>
                  <span>{item.label}</span>
                  <strong>{count ? `${count.toLocaleString()} indexed` : "Not found"}</strong>
                </li>
              );
            })}
            <li className={counts.shader ? "is-found" : "is-missing"}>
              <span>Shader</span>
              <strong>{counts.shader ? `${counts.shader.toLocaleString()} indexed` : "Not found"}</strong>
            </li>
          </ul>
          {status?.roots.length ? (
            <div className="asset-setup-roots">
              <span>Saved folders</span>
              {status.roots.map((root) => (
                <code key={root}>{root}</code>
              ))}
            </div>
          ) : (
            <p className="asset-setup-empty">
              No custom folders saved. Defaults checked: Desktop/KOBAedit, KOBAedit1–4, KOBAeditASSETS,
              Assets and Steam.
            </p>
          )}
          {status?.candidates.length ? (
            <div className="asset-setup-candidates">
              <span>Detected on this computer</span>
              {status.candidates.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => onPick(candidate)}
                  disabled={busy}
                >
                  <strong>Use this folder</strong>
                  <code>{candidate}</code>
                </button>
              ))}
            </div>
          ) : null}
          {missing.length > 0 && (
            <p className="asset-setup-warning">
              Add a folder containing {missing.map((item) => item.label).join(", ")}.
            </p>
          )}
        </div>
        <div className="launcher-foot asset-setup-actions">
          <button type="button" className="launcher-browse" onClick={onContinue}>
            Continue With Starter Kit
          </button>
          <button type="button" className="asset-setup-close" onClick={onClose}>
            Close
          </button>
          <button type="button" className="launcher-browse" onClick={onRescan} disabled={busy}>
            Rescan known folders
          </button>
          <button type="button" className="asset-setup-primary" onClick={onBrowse} disabled={busy}>
            {busy ? "Scanning…" : "Browse / Set Asset Folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
