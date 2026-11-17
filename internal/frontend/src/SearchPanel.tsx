import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView, Panel } from '@codemirror/view';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Tip } from '@/components/Tip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { TooltipProvider } from '@/components/ui/tooltip';

type Options = { caseSensitive: boolean; wholeWord: boolean; regexp: boolean };

const OPTIONS: [keyof Options, string, string][] = [
  ['caseSensitive', 'Aa', '大文字と小文字を区別'],
  ['wholeWord', 'ab', '単語単位'],
  ['regexp', '.*', '正規表現'],
];

// CodeMirror 標準の検索パネルの代わり。画面のほかの部分と同じ shadcn/ui の部品で組む
function SearchPanel({ view, own }: { view: EditorView; own: { query?: SearchQuery } }) {
  const [query, setQuery] = useState(() => getSearchQuery(view.state));

  const update = (patch: Partial<Options & { search: string }>) => {
    const next = new SearchQuery({
      search: query.search,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      regexp: query.regexp,
      ...patch,
    });
    setQuery(next);
    own.query = next;
    view.dispatch({ effects: setSearchQuery.of(next) });
  };

  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <Input
        main-field="true"
        aria-label="検索"
        placeholder="検索"
        className="h-7 flex-1 font-mono text-xs"
        value={query.search}
        onChange={(e) => update({ search: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.shiftKey ? findPrevious : findNext)(view);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      />
      {OPTIONS.map(([key, glyph, title]) => (
        <Tip key={key} label={title}>
          <Toggle
            size="sm"
            aria-label={title}
            className="h-7 min-w-7 px-1.5 font-mono text-xs"
            pressed={query[key]}
            onPressedChange={(on) => update({ [key]: on })}
          >
            <span className={key === 'wholeWord' ? 'underline underline-offset-2' : undefined}>{glyph}</span>
          </Toggle>
        </Tip>
      ))}
      <Tip label="前へ（Shift+Enter）">
        <Button variant="ghost" size="icon" className="size-7" onClick={() => findPrevious(view)}>
          <ArrowUp />
          <span className="sr-only">前へ</span>
        </Button>
      </Tip>
      <Tip label="次へ（Enter）">
        <Button variant="ghost" size="icon" className="size-7" onClick={() => findNext(view)}>
          <ArrowDown />
          <span className="sr-only">次へ</span>
        </Button>
      </Tip>
      <Tip label="閉じる（Esc）">
        <Button variant="ghost" size="icon" className="size-7" onClick={close}>
          <X />
          <span className="sr-only">閉じる</span>
        </Button>
      </Tip>
    </div>
  );
}

export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  const root = createRoot(dom);
  // パネル自身が出した検索語。これと違う検索語になったときだけ作り直す
  const own: { query?: SearchQuery } = {};
  let version = 0;
  // 別の React ツリーなので、Tooltip の Provider もここで持つ
  const render = () =>
    root.render(
      <TooltipProvider>
        <SearchPanel key={version} view={view} own={own} />
      </TooltipProvider>,
    );
  // 開いた直後に CodeMirror が入力欄へフォーカスを移すので、同期的に描画しておく
  flushSync(render);
  return {
    dom,
    top: true,
    // ⌘F で選択中の文字が検索語に入ったときなど、外から検索語が変わったら作り直す
    update(u) {
      if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) {
        const current = getSearchQuery(u.state);
        if (!(own.query && current.eq(own.query))) {
          own.query = current;
          version++;
          render();
        }
      }
    },
    destroy: () => queueMicrotask(() => root.unmount()),
  };
}
