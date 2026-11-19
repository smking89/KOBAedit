import type { CreatorBranding, WatermarkSettings } from "../lib/branding";

/**
 * Composite over the live preview. Pure CSS so it matches exactly what the
 * visual exports draw, and so it costs no WebGL work while a scene rebuilds.
 */
export function WatermarkOverlay({
  settings,
  branding,
}: {
  settings: WatermarkSettings;
  branding: CreatorBranding;
}) {
  if (settings.source === "off") return null;

  const logo = branding.logo;
  if (settings.source === "logo" && !logo) return null;
  if (settings.source === "text" && !settings.text.trim()) return null;

  const tint = `wm-${settings.tint}`;
  const style = {
    ["--wm-opacity" as string]: settings.opacity,
    ["--wm-scale" as string]: `${(settings.scale * 100).toFixed(2)}%`,
    ["--wm-padding" as string]: `${settings.padding}px`,
  } as React.CSSProperties;

  if (settings.anchor === "tiled" && settings.source === "logo" && logo) {
    return (
      <div className={`watermark-layer wm-tiled ${tint}`} style={style} aria-hidden="true">
        <div className="wm-tile" style={{ backgroundImage: `url(${logo})` }} />
      </div>
    );
  }

  return (
    <div
      className={`watermark-layer wm-anchor-${settings.anchor} ${tint}`}
      style={style}
      aria-hidden="true"
    >
      {settings.source === "logo" && logo ? (
        <img className="wm-mark" src={logo} alt="" />
      ) : (
        <span className="wm-text" style={{ fontSize: `${Math.round(settings.scale * 220)}px` }}>
          {settings.text}
        </span>
      )}
    </div>
  );
}
