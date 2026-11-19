import type { ReactNode } from "react";
/** Crisp 20px line icons for the viewport rail and properties tabs. */
export type IconName =
  | "select"
  | "move"
  | "rotate"
  | "scale"
  | "sculpt"
  | "paint"
  | "spline"
  | "cut"
  | "ruler"
  | "transform"
  | "terrain"
  | "material"
  | "puzzle"
  | "branding"
  | "render"
  | "step";

const paths: Record<IconName, ReactNode> = {
  select: <path d="M5 3l9 7-4 1 2.5 5-2 1L8 12l-3 3z" />,
  move: <path d="M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" />,
  rotate: <path d="M16 10a6 6 0 1 1-2-4.5M16 3v4h-4" />,
  scale: <path d="M3 3h6v6H3zM11 11h6v6h-6zM9 9l6-6" />,
  sculpt: <path d="M3 15c3-6 6 4 9-2s4-3 5-2M4 18h12" />,
  paint: <path d="M4 3h9l3 3v5H4zM7 16h6M8 11v5M12 11v3" />,
  spline: <path d="M3 16c4 0 4-10 8-10s4 8 6 8M3 16h.01M17 14h.01" />,
  cut: <path d="M4 4l10 10M14 4L4 14M12.5 12.5a2 2 0 1 0 2.8 2.8 2 2 0 0 0-2.8-2.8z" />,
  ruler: <path d="M3 7h14v6H3zM6 7v3M9 7v4M12 7v3M15 7v4" />,
  transform: <path d="M10 2v16M2 10h16M10 2l-2 2M10 2l2 2M10 18l-2-2M10 18l2-2" />,
  terrain: <path d="M2 16l5-9 4 6 2-3 5 6z" />,
  material: <path d="M10 2l7 4v8l-7 4-7-4V6zM3 6l7 4 7-4M10 10v8" />,
  puzzle: <path d="M8 3h4v3a1.5 1.5 0 1 0 3 0V3h2v6h-3a1.5 1.5 0 1 0 0 3h3v5h-5v-3a1.5 1.5 0 1 0-3 0v3H4v-5h3a1.5 1.5 0 1 0 0-3H4V3z" />,
  branding: <path d="M10 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L2.2 7.7l5.4-.8z" />,
  render: <path d="M2 4h16v12H2zM2 13l5-5 4 4 2-2 5 5M14 7h.01" />,
  step: <path d="M10 2v3M10 15v3M2 10h3M15 10h3M7 7l6 6M13 7l-6 6" />,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
