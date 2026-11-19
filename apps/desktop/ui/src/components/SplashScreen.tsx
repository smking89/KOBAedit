import { useEffect, useMemo, useRef, useState } from "react";

import { SPLASH_ART } from "../lib/theme";

const STEPS = [
  "Scanning local game bundles...",
  "Preparing 3D prefabs & shaders...",
  "Opening workspace...",
];

const SEEN_KEY = "koba-splash-seen";

/**
 * Frameless startup splash. Artwork crossfades at 0 / 35 / 70% rather than on a
 * timer, and a warm boot (already seen this session) dissolves in under a second.
 */
export function SplashScreen({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const stage = useMemo(() => (progress < 35 ? 0 : progress < 70 ? 1 : 2), [progress]);

  useEffect(() => {
    let warm = false;
    try {
      warm = window.sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      warm = false;
    }
    const duration = warm ? 700 : 2400;
    const started = performance.now();
    let timer = 0;
    const tick = () => {
      const elapsed = performance.now() - started;
      const next = Math.min(100, Math.round((elapsed / duration) * 100));
      setProgress(next);
      if (next >= 100 && !done.current) {
        done.current = true;
        try {
          window.sessionStorage.setItem(SEEN_KEY, "1");
        } catch {
          // Session storage unavailable: splash simply runs at full length.
        }
        setLeaving(true);
        window.setTimeout(onDone, 420);
        return;
      }
      timer = window.setInterval(tick, 45);
    };
    timer = window.setInterval(tick, 45);
    tick();
    return () => window.clearInterval(timer);
  }, [onDone]);

  return (
    <div className={`splash${leaving ? " is-leaving" : ""}`} role="status" aria-live="polite">
      <div className="splash-stage">
        {SPLASH_ART.slice(0, 3).map((art, index) => (
          <img
            key={art}
            className={`splash-art${index === stage ? " is-active" : ""}`}
            src={art}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        ))}
        <div className="splash-shade" aria-hidden="true" />
      </div>

      <div className="splash-brand">
        <img src="/koba-wordmark.png" alt="KOBA" draggable={false} />
        <p>KOBA EDIT · Map, Monument &amp; Skin Studio</p>
      </div>

      <div className="splash-status">
        <span className="splash-step">{STEPS[stage]}</span>
        <span className="splash-percent">{progress}%</span>
      </div>

      <div className="splash-bar" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
