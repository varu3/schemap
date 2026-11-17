import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { ChevronDown, Plus } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from 'react';
import { Tip } from '@/components/Tip';
import { cn } from '@/lib/utils';
import type { ColumnRow, DraftColumn, DraftNodeData, TableActions, TableDraft, TableNodeData } from './graph';
import { InlineError, inlineInputClass } from './InlineInput';

// 見出し 38px・列 26px は graph.ts の配置計算（HEADER_HEIGHT / ROW_HEIGHT）と合わせる
export function TableNode({ data, selected }: NodeProps<Node<TableNodeData>>) {
  const label = data.compact ? '開く' : '畳む';
  const inline = data.inline;
  const draft = inline?.kind === 'columns' ? inline.draft : undefined;
  const comment = inline?.kind === 'comment' ? inline : undefined;
  const editingTableComment = comment !== undefined && comment.column === undefined;
  const editingColumn = comment?.column;
  // 列を足している間は、打ち始める前の列を出す（足した列は下の入力の行で出す）
  const rows = draft ? draft.baseRows : data.rows;
  return (
    // はみ出しは切らない（テーブルのコメントの吹き出しを外に出すため）
    <div className={cn('group/table relative', data.showComments ? 'w-[480px]' : 'w-[320px]')}>
      {editingTableComment ? (
        <TableBubble>
          <CommentInput multiline value={comment?.value ?? ''} error={comment?.error} actions={data.actions} />
        </TableBubble>
      ) : (
        data.showComments &&
        data.comment && <TableBubble onEdit={() => data.actions?.startComment(data.name)}>{data.comment}</TableBubble>
      )}
      <div
        className={cn(
          'rounded-md border bg-card font-mono text-[13px] shadow-xs',
          selected && 'border-foreground/40 shadow-md',
          // フォーカスしているテーブルは、選んだテーブルの線と同じ青で囲む
          data.focused && 'border-[#0969da] ring-2 ring-[#0969da]/30',
        )}
      >
        <div className="relative flex h-[38px] items-center gap-1 rounded-t-[5px] border-b bg-app-accent-light px-1.5 font-semibold text-app-ink">
          {/* 畳んだテーブルへの線は見出しにつなぐ */}
          <Handle type="target" position={Position.Left} id="table-in" isConnectable={false} />
          <button
            type="button"
            title={label}
            aria-expanded={!data.compact}
            className={headerButton}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle?.(data.name);
            }}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', data.compact && '-rotate-90')} />
            <span className="sr-only">{label}</span>
          </button>
          <WithComment comment={data.comment}>
            <span className="min-w-0 flex-1 truncate">{data.name}</span>
          </WithComment>
          <button
            type="button"
            title="列を追加"
            className={cn(headerButton, 'opacity-0 group-hover/table:opacity-100 focus-visible:opacity-100')}
            onClick={(e) => {
              e.stopPropagation();
              data.actions?.startAddColumn(data.name);
            }}
          >
            <Plus className="size-3.5" />
            <span className="sr-only">列を追加</span>
          </button>
          {data.schema && <SchemaBadge>{data.schema}</SchemaBadge>}
          <Handle type="source" position={Position.Right} id="table-out" isConnectable={false} />
        </div>
        {!data.compact &&
          rows.map((r) => (
            <ColumnRowView
              key={r.name}
              row={r}
              handles
              showComments={data.showComments}
              onContextMenu={(e) => data.onColumnMenu?.(data.name, r.name, e.nativeEvent)}
              comment={
                editingColumn === r.name ? (
                  <Bubble>
                    <CommentInput value={comment?.value ?? ''} error={comment?.error} actions={data.actions} />
                  </Bubble>
                ) : undefined
              }
              onEditComment={() => data.actions?.startComment(data.name, r.name)}
            />
          ))}
        {draft && data.actions && <DraftColumns draft={draft} actions={data.actions} autoFocus />}
      </div>
    </div>
  );
}

// 新しく足すテーブル。名前と列を打つと、そのまま HCL に入る（Enter は次の欄へ移るだけ）
export function DraftTableNode({ data }: NodeProps<Node<DraftNodeData>>) {
  const { draft, actions } = data;
  const ref = useAutoFocus<HTMLInputElement>();
  return (
    <div
      data-draft
      className={cn(
        'rounded-md border border-dashed border-app-ink-40 bg-card font-mono text-[13px] shadow-md',
        // 足したあとのテーブルと同じ幅にする
        data.showComments ? 'w-[480px]' : 'w-[320px]',
      )}
    >
      <div className="relative flex h-[38px] items-center gap-1 rounded-t-[5px] border-b bg-app-accent-light pr-1.5 pl-7 font-semibold text-app-ink">
        <input
          ref={ref}
          aria-label="テーブル名"
          value={draft.name}
          placeholder="table_name"
          className={cn(inlineInputClass, 'flex-1')}
          onChange={(e) => actions.setDraftName(e.target.value)}
          onKeyDown={(e) => draftKeyDown(e, actions, () => focusField(e.currentTarget, 0, 'pk'))}
        />
        {data.schemas.length > 1 ? (
          <select
            aria-label="スキーマ"
            value={draft.schema}
            className="nodrag shrink-0 cursor-pointer appearance-none rounded border border-app-ink-40 bg-transparent px-1 text-[11px] font-normal text-app-ink-60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onChange={(e) => actions.setDraftSchema(e.target.value)}
            onKeyDown={(e) => draftKeyDown(e, actions)}
          >
            {data.schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <SchemaBadge>{draft.schema}</SchemaBadge>
        )}
      </div>
      {draft.pk && (
        <div className="relative flex h-[26px] items-center gap-1.5 bg-app-accent-light/40 px-2.5">
          <span className="w-[20px] shrink-0 text-[11px] text-muted-foreground">PK</span>
          <input
            aria-label="主キーの列名"
            data-field="pk"
            value={draft.pk.name}
            placeholder="id"
            className={cn(inlineInputClass, 'flex-1')}
            onChange={(e) => actions.setDraftPk({ name: e.target.value })}
            onKeyDown={(e) => draftKeyDown(e, actions, () => focusField(e.currentTarget, 0, 'name'))}
          />
          <TypeSelect
            field="pktype"
            value={draft.pk.type}
            onChange={(type) => actions.setDraftPk({ type })}
            onKeyDown={(e) => draftKeyDown(e, actions, () => focusField(e.currentTarget, 0, 'name'))}
          />
          {/* 主キーはいつも必須 */}
          <RequiredToggle required disabled />
        </div>
      )}
      {draft.baseRows.map((r) => (
        <ColumnRowView key={r.name} row={r} />
      ))}
      <DraftColumns draft={draft} actions={actions} />
    </div>
  );
}

// 打っている途中の列の行と、当てられなかったときの理由。末尾の空の行に打つと、その下に次の空の行が出る
function DraftColumns({
  draft,
  actions,
  autoFocus,
}: {
  draft: TableDraft;
  actions: TableActions;
  autoFocus?: boolean;
}) {
  return (
    <div data-draft className="rounded-b-[5px] border-t border-dashed bg-app-accent-light/40">
      {draft.columns.map((c, i) => (
        <DraftColumnRow key={c.key} index={i} column={c} actions={actions} autoFocus={autoFocus && i === 0} />
      ))}
      {draft.error && (
        <div role="status" className="px-2.5 py-1 font-sans text-xs leading-snug break-words text-destructive">
          {draft.error}
        </div>
      )}
    </div>
  );
}

function DraftColumnRow({
  index,
  column,
  actions,
  autoFocus,
}: {
  index: number;
  column: DraftColumn;
  actions: TableActions;
  autoFocus?: boolean;
}) {
  const nameRef = useAutoFocus<HTMLInputElement>(false, autoFocus === true);
  const set = (patch: Partial<Omit<DraftColumn, 'key'>>) => actions.setDraftColumn(column.key, patch);
  return (
    <div className="relative flex h-[26px] items-center gap-1.5 px-2.5">
      <Plus className="size-3 w-[20px] shrink-0 text-muted-foreground" />
      <input
        ref={nameRef}
        aria-label="列名"
        data-field="name"
        value={column.name}
        placeholder="column_name"
        className={cn(inlineInputClass, 'flex-1')}
        onChange={(e) => set({ name: e.target.value })}
        onKeyDown={(e) => draftKeyDown(e, actions, () => focusField(e.currentTarget, index, 'type'))}
      />
      <TypeSelect
        value={column.type}
        onChange={(type) => set({ type })}
        onKeyDown={(e) => draftKeyDown(e, actions, () => focusField(e.currentTarget, index + 1, 'name'))}
      />
      <RequiredToggle
        required={!column.null}
        onToggle={() => set({ null: !column.null })}
        onKeyDown={(e) => draftKeyDown(e, actions)}
      />
    </div>
  );
}

// 列の型の候補（Atlas の型と、HCL にある enum）。App が渡す
export const ColumnTypesContext = createContext<string[]>([]);

// 型は候補から選ぶ。候補に無い型（HCL に直接書いたもの）は、その型も候補に足して出す
function TypeSelect({
  field = 'type',
  value,
  onChange,
  onKeyDown,
}: {
  // Enter で移る先を探すときの名前。主キーの行は列の行と分ける
  field?: 'type' | 'pktype';
  value: string;
  onChange: (type: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLSelectElement>) => void;
}) {
  const types = useContext(ColumnTypesContext);
  const options = types.includes(value) ? types : [value, ...types];
  return (
    <select
      aria-label="型"
      data-field={field}
      value={value}
      className="nodrag nopan w-[140px] shrink-0 cursor-pointer rounded border border-transparent bg-transparent text-[12px] text-muted-foreground outline-none hover:border-border focus-visible:border-ring"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

// 必須（NOT NULL）かどうか。押して切り替える
function RequiredToggle({
  required,
  disabled,
  onToggle,
  onKeyDown,
}: {
  required: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={required}
      disabled={disabled}
      className={cn(
        'nodrag shrink-0 rounded border px-1 font-sans text-[11px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        required
          ? 'border-app-ink-40 bg-app-ink-7 text-app-ink'
          : 'border-dashed border-border text-muted-foreground/60 hover:text-muted-foreground',
        disabled && 'opacity-60',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      onKeyDown={onKeyDown}
    >
      必須
    </button>
  );
}

// Enter は次の欄へ移る。Esc は打ち始める前の中身に戻す
function draftKeyDown(e: KeyboardEvent<HTMLElement>, actions: TableActions | undefined, next?: () => void) {
  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
    e.preventDefault();
    e.stopPropagation();
    next?.();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    actions?.finishDraft('revert');
  }
}

// 同じテーブルの i 番目の列の行の欄に移る
function focusField(from: HTMLElement, index: number, field: 'pk' | 'name' | 'type') {
  const node = from.closest('.react-flow__node');
  const inputs = node?.querySelectorAll<HTMLElement>(`[data-draft] [data-field="${field}"]`);
  inputs?.[Math.min(index, inputs.length - 1)]?.focus({ preventScroll: true });
}

// 列の 1 行。打ち始める前からある列と、ふだんの列
function ColumnRowView({
  row: r,
  handles,
  showComments,
  comment,
  onContextMenu,
  onEditComment,
}: {
  row: ColumnRow;
  handles?: boolean;
  showComments?: boolean;
  // コメントを書き換えているときの入力欄（吹き出しの代わりに出す）
  comment?: ReactNode;
  onContextMenu?: (e: MouseEvent) => void;
  onEditComment?: () => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 右クリックは近道。同じ操作はテーブルのメニューからもできる
    <div
      className="erd-row relative flex h-[26px] items-center gap-1.5 px-2.5"
      onContextMenu={
        onContextMenu &&
        ((e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        })
      }
    >
      {handles && <Handle type="target" position={Position.Left} id={`${r.name}-in`} />}
      <span className="w-[20px] shrink-0 text-[11px] text-muted-foreground">{r.pk ? 'PK' : r.fk ? 'FK' : ''}</span>
      <WithComment comment={r.comment}>
        <span className={cn('truncate', showComments || comment ? 'max-w-[45%] shrink-0' : 'flex-1')}>{r.name}</span>
      </WithComment>
      {comment ??
        (showComments &&
          (r.comment ? <Bubble onEdit={onEditComment}>{r.comment}</Bubble> : <span className="flex-1" />))}
      {/* NULL を許す列は型の後ろに ? を付ける */}
      <span
        className="max-w-[120px] truncate text-muted-foreground"
        title={r.null ? `${r.type} NULL` : `${r.type} NOT NULL`}
      >
        {r.type}
        {r.null ? '?' : ''}
      </span>
      {handles && <Handle type="source" position={Position.Right} id={`${r.name}-out`} />}
    </div>
  );
}

// 吹き出しの中で、コメントをその場で書き換える。打つとそのまま HCL に入る。Enter で打ち終え、Esc で元に戻す。
// 空にするとコメントの行ごと消す。テーブルのコメントは Shift+Enter で改行できる
function CommentInput({
  value,
  error,
  multiline,
  actions,
}: {
  value: string;
  error?: string;
  multiline?: boolean;
  actions?: TableActions;
}) {
  const inputRef = useAutoFocus<HTMLInputElement>(true, !multiline);
  const areaRef = useAutoFocus<HTMLTextAreaElement>(true, multiline === true);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && multiline && e.shiftKey) {
      e.stopPropagation();
      return;
    }
    draftKeyDown(e as KeyboardEvent<HTMLElement>, actions, () => actions?.finishDraft('accept'));
  };
  const onChange = (v: string) => actions?.setDraftComment(v);
  return (
    <>
      {multiline ? (
        <textarea
          ref={areaRef}
          aria-label="コメント"
          value={value}
          placeholder="コメント"
          rows={Math.min(6, Math.max(1, value.split('\n').length))}
          className={cn(inlineInputClass, 'block w-[360px] resize-none')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <input
          ref={inputRef}
          aria-label="コメント"
          value={value}
          placeholder="コメント"
          className={cn(inlineInputClass, 'w-full')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      <InlineError error={error} />
    </>
  );
}

function useAutoFocus<T extends HTMLInputElement | HTMLTextAreaElement>(select = false, enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // メニューやノードのクリックが終わってから入力欄に移す。React Flow は測り終えるまでノードを隠すので、
    // 移れるまで数フレーム待つ
    let frame = 0;
    let id = 0;
    const tryFocus = () => {
      const el = ref.current;
      el?.focus({ preventScroll: true });
      if (el && document.activeElement === el) {
        if (select) {
          el.select();
        }
        return;
      }
      if (++frame < 30) {
        id = requestAnimationFrame(tryFocus);
      }
    };
    id = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(id);
  }, [select, enabled]);
  return ref;
}

const headerButton =
  'nodrag inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-app-ink-60 outline-none hover:bg-app-ink-7 hover:text-app-ink focus-visible:ring-2 focus-visible:ring-ring/50';

function SchemaBadge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded border border-app-ink-40 px-1 text-[11px] font-normal text-app-ink-60">
      {children}
    </span>
  );
}

// HCL の comment があるときだけ、マウスを乗せたら出す
function WithComment({ comment, children }: { comment?: string; children: ReactElement }) {
  return comment ? <Tip label={comment}>{children}</Tip> : children;
}

// 押したらその場で書き換えられるようにする（吹き出しの中身が文字のとき）
function editProps(onEdit?: () => void) {
  if (!onEdit) {
    return {};
  }
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      onEdit();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        onEdit();
      }
    },
  };
}

// コメントを常に出すときの吹き出し。左の尻尾が名前を指す。行の高さに収め、長ければ省略する
function Bubble({ children, onEdit }: { children: ReactNode; onEdit?: () => void }) {
  return (
    <span className="nodrag relative ml-1 flex min-w-0 flex-1 items-center">
      <span
        {...editProps(onEdit)}
        className={cn(
          'min-w-0 truncate rounded-md border bg-background px-1.5 font-sans text-xs leading-[18px] font-normal text-muted-foreground shadow-xs',
          onEdit ? 'cursor-text outline-none hover:border-foreground/30' : 'flex-1',
        )}
      >
        {children}
      </span>
      <span
        aria-hidden="true"
        className="absolute top-1/2 -left-[3px] size-1.5 -translate-y-1/2 rotate-45 border-b border-l bg-background"
      />
    </span>
  );
}

// テーブルのコメントの吹き出し。見出しの上に浮かせ、下の尻尾で見出しを指す。テーブルの外に出てよく、長ければ折り返す
function TableBubble({ children, onEdit }: { children: ReactNode; onEdit?: () => void }) {
  return (
    <div
      {...editProps(onEdit)}
      className={cn(
        'nodrag absolute bottom-full left-2 mb-2 w-max max-w-[400px] rounded-lg border bg-background px-2.5 py-1.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap break-words text-foreground shadow-md',
        onEdit && 'cursor-text outline-none hover:border-foreground/30',
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute -bottom-[5px] left-4 size-2.5 rotate-45 border-r border-b bg-background"
      />
    </div>
  );
}
