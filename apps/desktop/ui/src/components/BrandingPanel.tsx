import { useRef } from "react";

import {
  WATERMARK_ANCHORS,
  WATERMARK_TINTS,
  isBrandingLogo,
  type BrandingState,
  type WatermarkAnchor,
  type WatermarkSource,
} from "../lib/branding";

const SOURCES: { id: WatermarkSource; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "logo", label: "Logo" },
  { id: "text", label: "Text stamp" },
];

export function BrandingPanel({
  open,
  onClose,
  state,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  state: BrandingState;
  onChange: (next: BrandingState) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { branding, watermark } = state;

  const patchBranding = (patch: Partial<BrandingState["branding"]>) =>
    onChange({ ...state, branding: { ...branding, ...patch } });
  const patchWatermark = (patch: Partial<BrandingState["watermark"]>) =>
    onChange({ ...state, watermark: { ...watermark, ...patch } });

  const readLogo = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (isBrandingLogo(reader.result)) patchBranding({ logo: reader.result });
    };
    reader.readAsDataURL(file);
  };

  return (
    <aside
      className={`branding-panel${open ? " is-open" : ""}`}
      aria-label="Creator branding and watermark"
      aria-hidden={!open}
    >
      <header className="branding-head">
        <div>
          <p className="branding-eyebrow">Creator branding</p>
          <h2>Brand &amp; watermark</h2>
        </div>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="branding-body">
        <div className="branding-block">
          <h3>Profile</h3>
          <label className="branding-field">
            <span>Author name</span>
            <input
              type="text"
              value={branding.author}
              placeholder="KOBA"
              onChange={(event) => patchBranding({ author: event.target.value })}
            />
          </label>
          <label className="branding-field">
            <span>Server / brand name</span>
            <input
              type="text"
              value={branding.brand}
              placeholder="KOBA EDIT"
              onChange={(event) => patchBranding({ brand: event.target.value })}
            />
          </label>
          <label className="branding-field">
            <span>Support URL</span>
            <input
              type="text"
              inputMode="url"
              value={branding.supportUrl}
              placeholder="https://example.com/support"
              onChange={(event) => patchBranding({ supportUrl: event.target.value })}
            />
          </label>
          <label className="branding-field">
            <span>Chat prefix</span>
            <input
              type="text"
              value={branding.chatPrefix}
              maxLength={16}
              onChange={(event) => patchBranding({ chatPrefix: event.target.value })}
            />
          </label>
          <div className="branding-logo">
            <div className="branding-logo-preview">
              {branding.logo ? <img src={branding.logo} alt="" /> : <span>No logo</span>}
            </div>
            <div className="branding-logo-actions">
              <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>
                Upload logo
              </button>
              {branding.logo && (
                <button type="button" className="link-button" onClick={() => patchBranding({ logo: null })}>
                  Remove
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/svg+xml,image/webp"
                hidden
                onChange={(event) => readLogo(event.target.files?.[0])}
              />
            </div>
          </div>
        </div>

        <div className="branding-block">
          <h3>Watermark</h3>
          <div className="branding-segments" role="group" aria-label="Watermark source">
            {SOURCES.map((source) => (
              <button
                key={source.id}
                type="button"
                aria-pressed={watermark.source === source.id}
                className={watermark.source === source.id ? "is-active" : ""}
                onClick={() => patchWatermark({ source: source.id })}
              >
                {source.label}
              </button>
            ))}
          </div>

          {watermark.source === "text" && (
            <label className="branding-field">
              <span>Stamp text</span>
              <input
                type="text"
                maxLength={48}
                value={watermark.text}
                onChange={(event) => patchWatermark({ text: event.target.value })}
              />
            </label>
          )}

          <label className="branding-field">
            <span>Opacity {Math.round(watermark.opacity * 100)}%</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(watermark.opacity * 100)}
              onChange={(event) => patchWatermark({ opacity: Number(event.target.value) / 100 })}
            />
          </label>
          <label className="branding-field">
            <span>Scale {Math.round(watermark.scale * 100)}%</span>
            <input
              type="range"
              min={5}
              max={50}
              value={Math.round(watermark.scale * 100)}
              onChange={(event) => patchWatermark({ scale: Number(event.target.value) / 100 })}
            />
          </label>
          <label className="branding-field">
            <span>Edge padding {watermark.padding}px</span>
            <input
              type="range"
              min={0}
              max={120}
              value={watermark.padding}
              onChange={(event) => patchWatermark({ padding: Number(event.target.value) })}
            />
          </label>

          <div className="branding-anchors" role="group" aria-label="Watermark placement">
            {WATERMARK_ANCHORS.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                title={anchor.label}
                aria-label={anchor.label}
                aria-pressed={watermark.anchor === anchor.id}
                className={`branding-anchor${anchor.id === "tiled" ? " is-wide" : ""}${
                  watermark.anchor === anchor.id ? " is-active" : ""
                }`}
                onClick={() => patchWatermark({ anchor: anchor.id as WatermarkAnchor })}
              >
                {anchor.id === "tiled" ? "Tiled proof" : ""}
              </button>
            ))}
          </div>

          <div className="branding-segments" role="group" aria-label="Watermark contrast">
            {WATERMARK_TINTS.map((tint) => (
              <button
                key={tint.id}
                type="button"
                aria-pressed={watermark.tint === tint.id}
                className={watermark.tint === tint.id ? "is-active" : ""}
                onClick={() => patchWatermark({ tint: tint.id })}
              >
                {tint.label}
              </button>
            ))}
          </div>
          <p className="branding-hint">
            The watermark draws over the live preview and is saved on this machine. Uploaded logos are
            stored as data URLs and never leave the device.
          </p>
        </div>
      </section>
    </aside>
  );
}
