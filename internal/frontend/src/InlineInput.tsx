import { cn } from '@/lib/utils';

// 図の上で使う入力欄の見た目と、当てられなかったときに欄の下に出す理由。
// React Flow にドラッグや拡大縮小と見なされないよう、nodrag / nopan / nowheel を付ける
export const inlineInputClass =
  'nodrag nopan nowheel min-w-0 bg-transparent outline-none placeholder:text-muted-foreground/70';

export function InlineError({ error, className }: { error?: string; className?: string }) {
  if (!error) {
    return null;
  }
  return (
    <span
      role="status"
      className={cn(
        'absolute top-full left-0 z-20 mt-1 w-max max-w-[320px] rounded-md border border-destructive/40 bg-background px-2 py-1 font-sans text-[11px] leading-snug font-normal break-words whitespace-normal text-destructive shadow-md',
        className,
      )}
    >
      {error}
    </span>
  );
}
