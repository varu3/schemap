import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { atlasCompletion } from './atlas-complete';
import { hcl } from './hcl';
import { createSearchPanel } from './SearchPanel';
import type { Schema } from './types';

export type HclEditorHandle = { openSearch: () => void };

// 選んだテーブルのブロック（行の範囲）に色を付ける
const setBlock = StateEffect.define<{ from: number; to: number } | null>();
const blockLine = Decoration.line({ class: 'cm-block' });

const blockField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setBlock)) {
        if (!e.value) {
          return Decoration.none;
        }
        const ranges = [];
        for (let n = e.value.from; n <= e.value.to; n++) {
          ranges.push(blockLine.range(tr.state.doc.line(n).from));
        }
        return Decoration.set(ranges);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 構文エラーの行に印を付ける
const setErrorLine = StateEffect.define<number | null>();
const errorLine = Decoration.line({ class: 'cm-error-line' });

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        const n = e.value;
        return n && n <= tr.state.doc.lines
          ? Decoration.set([errorLine.range(tr.state.doc.line(n).from)])
          : Decoration.none;
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 色は shadcn/ui のダークテーマの変数を使う（エディタの区画は .dark の中に置く）
const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--background)', color: 'var(--foreground)', height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    '.cm-content': { caretColor: 'var(--foreground)' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-gutters': {
      backgroundColor: 'var(--background)',
      color: 'var(--muted-foreground)',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'oklch(1 0 0 / 4%)' },
    '.cm-activeLineGutter': { backgroundColor: 'oklch(1 0 0 / 4%)', color: 'var(--foreground)' },
    '.cm-block': { backgroundColor: 'oklch(1 0 0 / 5%)', boxShadow: 'inset 2px 0 0 var(--muted-foreground)' },
    '.cm-error-line': { backgroundColor: 'rgb(239 68 68 / 15%)', boxShadow: 'inset 2px 0 0 var(--destructive)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgb(30 142 232 / 30%)' },
    '.cm-searchMatch': { backgroundColor: 'rgb(234 179 8 / 30%)', outline: '1px solid rgb(234 179 8 / 60%)' },
    '.cm-searchMatch-selected': { backgroundColor: 'rgb(234 179 8 / 60%)' },
    '.cm-selectionMatch': { backgroundColor: 'rgb(30 142 232 / 20%)' },
    '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--foreground)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    // 入力候補の一覧。shadcn のポップオーバーと同じ色と角丸
    '.cm-tooltip': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'ui-monospace, monospace', maxHeight: '16em' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--foreground)' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: '#79c0ff' },
    // 差分: 足した行は緑、消した行は赤
    '.cm-changedLine': { backgroundColor: 'rgb(46 160 67 / 15%) !important' },
    '.cm-changedText': { background: 'rgb(46 160 67 / 35%)' },
    '.cm-deletedChunk': { backgroundColor: 'rgb(248 81 73 / 12%)' },
    '.cm-deletedChunk .cm-deletedText': { background: 'rgb(248 81 73 / 35%)' },
    '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
    '.cm-changedLineGutter': { background: 'rgb(46 160 67)' },
    '.cm-deletedLineGutter': { background: 'rgb(248 81 73)' },
    '.cm-chunkButtons button': {
      border: '1px solid var(--border)',
      borderRadius: '4px',
      background: 'var(--card)',
      color: 'var(--foreground)',
      fontSize: '12px',
      padding: '0 6px',
      cursor: 'pointer',
    },
  },
  { dark: true },
);

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#ff7b72' },
  { tag: t.propertyName, color: '#79c0ff' },
  { tag: t.string, color: '#a5d6ff' },
  { tag: t.comment, color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.number, t.atom], color: '#79c0ff' },
  { tag: t.variableName, color: '#d2a8ff' },
]);

const readOnly = new Compartment();
// ビジュアル側の編集など、外から中身を差し替えた変更の印。打った変更ではないので onEdit に戻さない
const external = Annotation.define<boolean>();
// 差分の表示。オンのときはディスク上の中身（original）との違いをエディタの中に出す
const diffView = new Compartment();

function diffExtension(show: boolean, original: string | undefined): Extension {
  return show && original !== undefined ? unifiedMergeView({ original, gutter: true, mergeControls: true }) : [];
}

function baseExtensions(onDocChange: (doc: string) => void, getSchema: () => Schema | undefined): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    indentOnInput(),
    // { [ " を打ったら閉じる側も入れる
    closeBrackets(),
    autocompletion({ override: [atlasCompletion(getSchema)], icons: false }),
    hcl,
    syntaxHighlighting(darkHighlight),
    darkTheme,
    blockField,
    errorField,
    search({ top: true, createPanel: createSearchPanel }),
    highlightSelectionMatches(),
    keymap.of([
      // Mac でも Ctrl で操作できるようにする（Mod は ⌘）
      { key: 'Ctrl-f', run: openSearchPanel, preventDefault: true },
      { key: 'Ctrl-z', run: undo, preventDefault: true },
      { key: 'Ctrl-Shift-z', run: redo, preventDefault: true },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) {
        onDocChange(u.state.doc.toString());
      }
    }),
  ];
}

type Props = {
  // ファイルの名前。変わったときだけエディタを作り直す
  path: string;
  source: string;
  line: number;
  endLine: number;
  // 変わったときだけブロックまでスクロールする（編集で行番号がずれたときはスクロールしない）
  scrollKey: string;
  editable: boolean;
  errorLine?: number;
  onEdit: (doc: string) => void;
  // 入力候補のテーブル名・列名・enum を取るために使う
  schema?: Schema;
  // ディスク上の中身。showDiff のとき、これとの差分を出す
  original?: string;
  showDiff: boolean;
  ref?: Ref<HclEditorHandle>;
};

// ファイル全体を表示し、line〜endLine のブロックに色を付ける
export function HclEditor({
  path,
  source,
  line,
  endLine,
  scrollKey,
  editable,
  errorLine: error,
  onEdit,
  schema,
  original,
  showDiff,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  // 今エディタに入っている中身。打った内容が親から source として戻ってきたときに作り直さないため
  const loaded = useRef<string>(undefined);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  const diffRef = useRef({ showDiff, original });
  diffRef.current = { showDiff, original };

  useImperativeHandle(ref, () => ({
    openSearch: () => {
      if (view.current) {
        openSearchPanel(view.current);
      }
    },
  }));

  useEffect(() => {
    if (!host.current) {
      return;
    }
    const v = new EditorView({ parent: host.current });
    view.current = v;
    return () => v.destroy();
  }, []);

  // 別のファイルに切り替えたときだけ作り直す。同じファイルの中身が外から変わったとき（ビジュアル側の編集）は、
  // 違う部分だけを差し替えて、取り消しの履歴・カーソル・スクロールを残す
  const loadedPath = useRef<string>(undefined);
  useEffect(() => {
    const v = view.current;
    if (!v || loaded.current === source) {
      return;
    }
    if (loadedPath.current === path) {
      const current = v.state.doc.toString();
      let from = 0;
      while (from < current.length && from < source.length && current[from] === source[from]) {
        from++;
      }
      let end = 0;
      while (
        end < current.length - from &&
        end < source.length - from &&
        current[current.length - 1 - end] === source[source.length - 1 - end]
      ) {
        end++;
      }
      v.dispatch({
        changes: { from, to: current.length - end, insert: source.slice(from, source.length - end) },
        annotations: external.of(true),
      });
      loaded.current = source;
      return;
    }
    loadedPath.current = path;
    loaded.current = source;
    v.setState(
      EditorState.create({
        doc: source,
        extensions: [
          baseExtensions(
            (doc) => {
              loaded.current = doc;
              onEditRef.current(doc);
            },
            () => schemaRef.current,
          ),
          readOnly.of(EditorState.readOnly.of(!editable)),
          diffView.of(diffExtension(diffRef.current.showDiff, diffRef.current.original)),
        ],
      }),
    );
  }, [path, source, editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(!editable)) });
  }, [editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: diffView.reconfigure(diffExtension(showDiff, original)) });
  }, [showDiff, original]);

  useEffect(() => {
    const v = view.current;
    if (!v || line < 1 || endLine > v.state.doc.lines) {
      return;
    }
    v.dispatch({ effects: setBlock.of({ from: line, to: endLine }) });
  }, [line, endLine]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: スクロールは選んだテーブルが変わったときだけ
  useEffect(() => {
    const v = view.current;
    if (!v || line < 1 || line > v.state.doc.lines) {
      return;
    }
    v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(line).from, { y: 'start', yMargin: 24 }) });
  }, [scrollKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(error ?? null) });
  }, [error]);

  return <div className="min-h-0 flex-1 overflow-hidden" ref={host} />;
}
