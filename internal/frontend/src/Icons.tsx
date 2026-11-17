import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

// テーブル名だけを表示: 見出しの帯だけで本体が空のテーブル
export function IconTableHeader(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 4a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 4v2.5H2z" fill="currentColor" stroke="none" opacity=".3" />
      <path d="M2 6.5h12" />
    </Icon>
  );
}

// 線の形 3 種は始点と終点を共通にし、経路だけを変える
function EdgeNodes() {
  return (
    <>
      <rect x="1.5" y="10" width="3" height="3" rx=".5" fill="currentColor" stroke="none" />
      <rect x="11.5" y="3" width="3" height="3" rx=".5" fill="currentColor" stroke="none" />
    </>
  );
}

export function IconEdgeBezier(props: IconProps) {
  return (
    <Icon {...props}>
      <EdgeNodes />
      <path d="M4.5 11.5C8 11.5 8 4.5 11.5 4.5" />
    </Icon>
  );
}

export function IconEdgeStep(props: IconProps) {
  return (
    <Icon {...props}>
      <EdgeNodes />
      <path d="M4.5 11.5H8V4.5H11.5" />
    </Icon>
  );
}

export function IconEdgeStraight(props: IconProps) {
  return (
    <Icon {...props}>
      <EdgeNodes />
      <path d="M4.5 11.5L11.5 4.5" />
    </Icon>
  );
}
