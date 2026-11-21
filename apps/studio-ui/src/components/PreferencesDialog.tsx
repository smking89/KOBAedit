import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { SPLASH_ART } from "../lib/theme";
import {
  MAX_CUSTOM_SPLASH_CHARS,
  loadSplashPrefs,
  sanitizeSplashPrefs,
  saveSplashPrefs,
  type SplashMode,
  type SplashPrefs,
} from "../lib/splashPrefs";

const MODES: Array<{ mode: SplashMode; label: string; detail: string }> = [
  { mode: "rotate", label: "Rotate heroes", detail: "Five local heroes crossfade, starting on the next one each launch." },
  { mode: "lock", label: "Lock one hero", detail: "One still image for every launch." },
  { mode: "custom", label: "Custom image", detail: "Use your own picture, stored on this machine." },
];

/**
 * Preferences dialog. Only the splash background lives here for now; the choice
 * is written to `localStorage`, which the splash window reads on next launch.
 */
export function PreferencesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prefs, setPrefs] = useState<SplashPrefs>(() => loadSplashPrefs());
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPrefs(loadSplashPrefs());
    setNote(null);
  }, [open]);

  const update = (next: SplashPrefs, message?: string) => {
    const clean = sanitizeSplashPrefs(next);
    setPrefs(clean);
    saveSplashPrefs(clean);
    setNote(message ?? null);
  };

  const pickCustom = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read that image."));
      reader.readAsDataURL(file);
    }).catch((error: Error) => {
      setNote(error.message);
      return "";
    });
    if (!dataUrl) return;
    if (dataUrl.length > MAX_CUSTOM_SPLASH_CHARS) {
      setNote("That image is too large for local storage; keep it under about 2.5 MB.");
      return;
    }
    update({ ...prefs, mode: "custom", custom: dataUrl }, `${file.name} will be used on the next launch.`);
  };

  if (!open) return null;

  return (
    <div className="prefs-backdrop" role="presentation" onClick={onClose}>
      <section
        className="prefs-card"
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="prefs-head">
          <h2>Preferences</h2>
          <button type="button" className="link-button" onClick={onClose}>
            Done
          </button>
        </header>

        <div className="prefs-group">
          <span className="section-label">Splash background</span>
          {MODES.map(({ mode, label, detail }) => (
            <label className="prefs-option" key={mode}>
              <input
                type="radio"
                name="koba-splash-mode"
                checked={prefs.mode === mode}
                onChange={() => update({ ...prefs, mode })}
              />
              <span>
                <strong>{label}</strong>
                <em>{detail}</em>
              </span>
            </label>
          ))}
        </div>

        {prefs.mode === "lock" && (
          <div className="prefs-heroes">
            {SPLASH_ART.map((art, index) => (
              <button
                key={art}
                type="button"
                className={`prefs-hero${prefs.hero === art ? " is-active" : ""}`}
                style={{ backgroundImage: `url(${art})` }}
                onClick={() => update({ ...prefs, hero: art })}
                aria-label={`Splash hero ${index + 1}`}
                aria-pressed={prefs.hero === art}
              />
            ))}
          </div>
        )}

        {prefs.mode === "custom" && (
          <div className="prefs-custom">
            <button type="button" className="button" onClick={() => fileRef.current?.click()}>
              Choose image…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => void pickCustom(event)}
            />
            {prefs.custom ? (
              <img className="prefs-custom-preview" src={prefs.custom} alt="Custom splash preview" />
            ) : (
              <p className="prefs-hint">PNG, JPEG or WebP, up to about 2.5 MB.</p>
            )}
          </div>
        )}

        <p className="prefs-hint">The wordmark sits in the same spot on every background.</p>
        {note && <p className="prefs-note">{note}</p>}
      </section>
    </div>
  );
}
