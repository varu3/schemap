import type { End } from './graph';

// 線の色ごとにマーカーを用意する。マーカーは線の色を引き継げないため
// 選んだテーブルにつながる線は青。SVG の marker は CSS 変数を引き継げないので値を直接書く
export const MARKER_COLORS = {
  default: '#b1b1b7',
  selected: '#0969da',
} as const;

export type MarkerColor = keyof typeof MARKER_COLORS;

export function markerId(end: End, color: MarkerColor): string {
  return `schemap-${end}-${color}`;
}

// 線が左から入り、右端（x=20）がテーブルの縁に来る向きで描く。
// 始点側は orient="auto-start-reverse" で向きが反転する
function Shape({ end, color }: { end: End; color: string }) {
  const circle = (cx: number) => <circle cx={cx} cy="10" r="3.5" fill="#fff" stroke={color} />;
  switch (end) {
    case 'one':
      return <path d="M12 4v12M16 4v12" stroke={color} />;
    case 'zeroOne':
      return (
        <>
          <path d="M16 4v12" stroke={color} />
          {circle(8)}
        </>
      );
    case 'zeroMany':
      return (
        <>
          <path d="M11 10L20 3M11 10L20 17M11 10H20" stroke={color} />
          {circle(6)}
        </>
      );
  }
}

const ENDS: End[] = ['zeroMany', 'zeroOne', 'one'];

export function Markers() {
  return (
    <svg className="schemap-markers" aria-hidden="true">
      <defs>
        {ENDS.flatMap((end) =>
          (Object.keys(MARKER_COLORS) as MarkerColor[]).map((color) => (
            <marker
              key={markerId(end, color)}
              id={markerId(end, color)}
              viewBox="0 0 20 20"
              refX="20"
              refY="10"
              markerWidth="20"
              markerHeight="20"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
              fill="none"
              strokeWidth="1.5"
            >
              <Shape end={end} color={MARKER_COLORS[color]} />
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}
