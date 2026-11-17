import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
  Panel,
  ReactFlow,
  type Rect,
  type Transform,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type XYPosition,
} from '@xyflow/react';
import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FileCode2,
  Focus as FocusIcon,
  GitCompare,
  GitPullRequest,
  MessageSquareText,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Tip } from '@/components/Tip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { type EditOp, editFile, fetchSchema, fetchSchemaEdited, type ParseError, saveFile } from './api';
import { COLUMN_TYPES } from './atlas-complete';
import {
  allTableNames,
  buildEdges,
  type DraftColumn,
  type DraftNodeData,
  type EdgeType,
  findTable,
  GRID,
  type InlineEdit,
  layoutNodes,
  nodeHeight,
  relatedTables,
  type TableActions,
  type TableDraft,
  type TableNodeData,
} from './graph';
import { HclEditor, type HclEditorHandle } from './HclEditor';
import { HOSTED, hostedMeta, keepHostedParams } from './hosted/config';
import { HostedBar } from './hosted/HostedBar';
import { IconEdgeBezier, IconEdgeStep, IconEdgeStraight, type IconProps, IconTableHeader } from './Icons';
import { type MarkerColor, Markers, markerId } from './Markers';
import { ColumnTypesContext, DraftTableNode, TableNode } from './TableNode';
import type { Schema } from './types';

const nodeTypes = { table: TableNode, draft: DraftTableNode };

// 新しく足すテーブルを打っている間だけ図に出すノード
const DRAFT_ID = '__draft__';

// 図の上で打っている途中のテーブル。path は当てる先のファイル、base は打ち始める前の中身
type Session = TableDraft & { path: string; base: string };

// 打っている内容を、打ち始める前の中身に当てる操作の並びにする。名前が空のテーブル・列は入れない
function sessionOps(s: Session): EditOp[] {
  const table = s.name.trim();
  if (!table) {
    return [];
  }
  if (s.comment) {
    return [{ kind: 'setComment', table, column: s.comment.column, comment: s.comment.value.trim() }];
  }
  const ops: EditOp[] = s.isNew
    ? [{ kind: 'addTable', table, schema: s.schema, name: s.pk?.name.trim() || undefined, type: s.pk?.type }]
    : [];
  for (const c of s.columns) {
    const name = c.name.trim();
    if (name) {
      ops.push({ kind: 'addColumn', table, name, type: c.type.trim() || 'text', null: c.null });
    }
  }
  return ops;
}

function inlineFor(id: string, s: Session | undefined, error: string | undefined): InlineEdit | undefined {
  if (!s || s.isNew || s.name !== id) {
    return undefined;
  }
  return s.comment
    ? { kind: 'comment', column: s.comment.column, value: s.comment.value, error }
    : { kind: 'columns', draft: { ...s, error } };
}

const EDGE_TYPES: [EdgeType, string][] = [
  ['default', '曲線'],
  ['step', '直角'],
  ['straight', '直線'],
];

function parseEdgeType(v: string | null): EdgeType {
  return EDGE_TYPES.find(([t]) => t === v)?.[0] ?? 'default';
}

const EDGE_ICONS: Record<EdgeType, ComponentType<IconProps>> = {
  default: IconEdgeBezier,
  step: IconEdgeStep,
  straight: IconEdgeStraight,
};

// フォーカスしたテーブル。withRelated なら FK で直接つながるテーブルも出す
type Focus = { tables: string[]; withRelated: boolean };

function splitNames(v: string | null): string[] {
  return v ? v.split(',').filter((n) => n !== '') : [];
}

function parseFocus(q: URLSearchParams): Focus | undefined {
  const tables = splitNames(q.get('focus'));
  return tables.length > 0 ? { tables, withRelated: q.get('only') !== '1' } : undefined;
}

// 今の画面の範囲を図の座標で返す
function viewRect(width: number, height: number, [tx, ty, zoom]: Transform): Rect {
  return { x: -tx / zoom, y: -ty / zoom, width: width / zoom, height: height / zoom };
}

function nodeRect(n: Node<TableNodeData>): Rect {
  return { x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// 配置をやり直すときに画面の基準にするテーブル。
// 選んでいるテーブルが画面に入っていればそれ、無ければ画面の中心に最も近いテーブル
function pickAnchor(
  nodes: Node<TableNodeData>[],
  primary: string | undefined,
  view: Rect,
): Node<TableNodeData> | undefined {
  const picked = nodes.find((n) => n.id === primary);
  if (picked && overlaps(nodeRect(picked), view)) {
    return picked;
  }
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  let best: Node<TableNodeData> | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    const r = nodeRect(n);
    const dist = (r.x + r.width / 2 - cx) ** 2 + (r.y + r.height / 2 - cy) ** 2;
    if (dist < bestDist) {
      best = n;
      bestDist = dist;
    }
  }
  return best;
}

function clampWidth(w: number): number {
  return Math.min(Math.max(w, 280), 960);
}

type Move = { id: string; from: XYPosition; to: XYPosition };

type EditorTarget = { name: string; file: string; line: number; endLine: number };

// 畳んだエディタの帯の幅
const COLLAPSED_EDITOR_WIDTH = 28;

// 起動時の表示の設定は URL から読む（書き戻しは App の useEffect）。
const initial = new URLSearchParams(window.location.search);

export function App() {
  const [data, setData] = useState<Schema>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  // 図に出しているテーブル。最初は全部
  const [shown, setShown] = useState<Set<string>>(new Set());
  // 読み込むファイル（db/schema からの相対パス）。外したファイルのテーブルは一覧にも図にも出さない
  const [files, setFiles] = useState<Set<string>>(new Set());
  // 選んでいるテーブル。最後に選んだものが末尾（詳細を出す対象）
  const [selection, setSelection] = useState<string[]>([]);
  // テーブル名だけにしている（列を畳んだ）テーブル
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 一括で畳む・開くときだけ配置をやり直す。1 テーブルずつの開閉では位置を動かさない
  const [layoutVersion, setLayoutVersion] = useState(0);
  // テーブル名と列名の横にコメントを常に出す
  // 既定はオン。オフにしたときだけ URL に comments=0 を残す
  const [showComments, setShowComments] = useState(initial.get('comments') !== '0');
  const [edgeType, setEdgeType] = useState<EdgeType>(parseEdgeType(initial.get('edge')));
  const [focus, setFocus] = useState<Focus | undefined>(parseFocus(initial));
  // column があるときは列の行の右クリック（コメントの編集だけを出す）
  // edge があるときはリレーションの線の右クリック（FK を持つテーブルと FK の名前）
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    tables: string[];
    column?: string;
    edge?: { table: string; fk: string };
  }>();
  // 図の上で打っている途中のテーブル。打つたびに HCL に当てる。一度に 1 つだけ
  const [session, setSession] = useState<Session>();
  const [sessionError, setSessionError] = useState<string>();
  // 新しいテーブルの、最後に HCL に当てた名前。打っている間は図にこのテーブルを出さず、空のテーブルの方を出す
  const [appliedName, setAppliedName] = useState<string>();
  const [draftNode, setDraftNode] = useState<Node<DraftNodeData>>();
  // ビジュアル側の編集が HCL に当てられなかったときの知らせ（FK のドラッグなど、入力欄が無い操作）
  const [notice, setNotice] = useState<string>();
  // FK を引いている間は、相手の列の接続点を出す
  const [connecting, setConnecting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(true);
  const [editorWidth, setEditorWidth] = useState(460);
  // エディタで編集中のファイル（パス → 中身）。保存するまでファイルには書かない
  const [editedFiles, setEditedFiles] = useState<Record<string, string>>({});
  const [parseError, setParseError] = useState<ParseError>();
  // ディスク上の中身（読み込んだとき、または最後に保存したとき）。差分と保存の競合の確認に使う
  const [originals, setOriginals] = useState<Record<string, { source: string; hash: string }>>({});
  const [showDiff, setShowDiff] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const isDirty = (path: string) => editedFiles[path] !== undefined && editedFiles[path] !== originals[path]?.source;
  // hosted ビルドで、読むだけのブランチ（main など）を開いているとき。編集の入口をすべて止める
  const readOnly = HOSTED && data !== undefined && hostedMeta()?.editable !== true;
  const READ_ONLY_NOTICE = 'このブランチは読み取り専用です。編集するには、編集できるブランチに切り替えてください';
  // hosted ビルドの「PR を作成」の入力欄を出しているか
  const [prOpen, setPrOpen] = useState(false);
  const { fitView, setCenter, getZoom, getInternalNode } = useReactFlow();
  // 図の幅が決まってから寄せる。右のエディタの開閉で図の幅が変わっている間は待ち、
  // 変わり終わってから（幅が変わらなければ少し待ってから）fn を動かす
  const pendingMove = useRef<() => void>(undefined);
  const moveTimer = useRef<number>(undefined);
  const flushMove = useCallback(() => {
    const fn = pendingMove.current;
    pendingMove.current = undefined;
    if (fn) {
      window.requestAnimationFrame(fn);
    }
  }, []);
  const afterPane = useCallback(
    (fn: () => void) => {
      pendingMove.current = fn;
      window.clearTimeout(moveTimer.current);
      // クリックからエディタが開き始めるまでの間に幅が変わり始めなければ、そのまま寄せる
      moveTimer.current = window.setTimeout(flushMove, 120);
    },
    [flushMove],
  );
  const store = useStoreApi<Node<TableNodeData>>();

  // 起動時に作業ツリーの db/schema を読む。URL の table / collapsed の状態から始める
  useEffect(() => {
    fetchSchema()
      .then((sc) => {
        setData(sc);
        setOriginals(Object.fromEntries(sc.files.map((f) => [f.path, { source: f.source, hash: f.hash }])));
        setSelection(splitNames(initial.get('table')));
        const f = initial.get('files');
        setFiles(new Set(f === null ? sc.files.map((x) => x.path) : splitNames(f)));
        const show = initial.get('show');
        setShown(new Set(show === null ? allTableNames(sc) : splitNames(show)));
        const c = initial.get('collapsed');
        setCollapsed(new Set(c === '*' ? allTableNames(sc) : splitNames(c)));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // 表示の設定を URL に残す。リロードや共有で同じ見え方を開ける
  useEffect(() => {
    if (!data) {
      return;
    }
    const q = new URLSearchParams();
    if (!data.files.every((f) => files.has(f.path))) {
      q.set('files', [...files].join(','));
    }
    const all = allTableNames(data);
    if (!all.every((n) => shown.has(n))) {
      q.set('show', [...shown].join(','));
    }
    if (collapsed.size > 0) {
      q.set('collapsed', all.every((n) => collapsed.has(n)) ? '*' : [...collapsed].join(','));
    }
    if (!showComments) {
      q.set('comments', '0');
    }
    if (edgeType !== 'default') {
      q.set('edge', edgeType);
    }
    if (focus) {
      q.set('focus', focus.tables.join(','));
      if (!focus.withRelated) {
        q.set('only', '1');
      }
    }
    if (selection.length > 0) {
      q.set('table', selection.join(','));
    }
    keepHostedParams(q);
    window.history.replaceState(null, '', `?${q}`);
  }, [data, files, shown, collapsed, showComments, edgeType, focus, selection]);

  const inFiles = useCallback(
    (name: string) => {
      const t = data ? findTable(data, name) : undefined;
      return t !== undefined && files.has(t.range.file);
    },
    [data, files],
  );

  // フォーカス中は、フォーカスしたテーブル（と、FK で直接つながるテーブル）だけを出す
  const visible = useMemo(() => {
    if (!data) {
      return new Set<string>();
    }
    if (!focus) {
      return new Set([...shown].filter((n) => inFiles(n)));
    }
    if (!focus.withRelated) {
      return new Set(focus.tables);
    }
    return new Set(focus.tables.flatMap((t) => [...relatedTables(data, t)]));
  }, [data, focus, shown, inFiles]);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion は一括の開閉で配置をやり直すための合図
  const layoutResult = useMemo(
    () => (data ? layoutNodes(data, visible, collapsedRef.current, showComments) : []),
    [data, visible, layoutVersion, showComments],
  );
  const nodeIds = useMemo(() => new Set(layoutResult.map((n) => n.id)), [layoutResult]);

  // 列の行の右クリック。そのテーブルを選び、コメントの編集のメニューを出す
  const openColumnMenu = useCallback((table: string, column: string, e: MouseEvent) => {
    setSelection([table]);
    setMenu({ x: e.clientX, y: e.clientY, tables: [table], column });
  }, []);

  const toggleTable = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
  }, []);

  // ドラッグで動かせるように、配置の結果を React Flow 側の状態に移す
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selected = useMemo(() => new Set(selection), [selection]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const focused = useMemo(() => new Set(focus?.tables ?? []), [focus]);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const needsFit = useRef(false);
  // 一括の開閉で配置をやり直すときは、表示位置と倍率を変えずに、基準のテーブルが画面上の同じ場所に残るよう
  // 新しい配置全体をずらす
  const anchorOnRelayout = useRef(false);
  // エディタの編集で解析し直したときは、今あるテーブルの位置をそのまま使う
  const preserveLayout = useRef(false);
  const placeNew = useRef<{ name: string; position: XYPosition }>(undefined);
  const inlineRef = useRef({ session, sessionError });
  inlineRef.current = { session, sessionError };
  // 手で動かしたテーブルと、図の上で足したテーブルの位置。配置をやり直しても（テーブルを図に足す、ファイルを切り替える、
  // フォーカスを解くなど）この位置に置く。フォーカス中の配置は別に組むので、位置も別に持ち、フォーカスを解いたら捨てる
  const pinned = useRef({ all: new Map<string, XYPosition>(), focus: new Map<string, XYPosition>() });
  const pinsNow = useCallback(() => (focusRef.current ? pinned.current.focus : pinned.current.all), []);
  useEffect(() => {
    if (!focus) {
      pinned.current.focus.clear();
    }
  }, [focus]);
  // テーブルの部品から呼ぶ操作。中身は毎回の描画で差し替え、渡す入れ物は変えない（ノードを作り直さないため）
  const actionsRef = useRef<TableActions>(undefined);
  const actions = useMemo<TableActions>(
    () => ({
      startAddColumn: (t) => actionsRef.current?.startAddColumn(t),
      startComment: (t, c) => actionsRef.current?.startComment(t, c),
      setDraftComment: (v) => actionsRef.current?.setDraftComment(v),
      setDraftName: (n) => actionsRef.current?.setDraftName(n),
      setDraftSchema: (sc) => actionsRef.current?.setDraftSchema(sc),
      setDraftColumn: (k, p) => actionsRef.current?.setDraftColumn(k, p),
      setDraftPk: (p) => actionsRef.current?.setDraftPk(p),
      finishDraft: (m) => actionsRef.current?.finishDraft(m),
    }),
    [],
  );
  const moveHistory = useRef<{ undo: Move[][]; redo: Move[][] }>({ undo: [], redo: [] });
  useEffect(() => {
    let placed = layoutResult;
    let anchored = false;
    const pins = pinsNow();
    if (preserveLayout.current) {
      preserveLayout.current = false;
      const old = new Map(nodesRef.current.map((n) => [n.id, n.position]));
      // ビジュアル側で足したテーブルは、足したときの画面の中央に置く
      const place = placeNew.current;
      placeNew.current = undefined;
      placed = layoutResult.map((n) => {
        if (place && n.id === place.name) {
          return { ...n, position: place.position };
        }
        const prev = old.get(n.id);
        return prev ? { ...n, position: prev } : n;
      });
      anchored = true;
    } else {
      // 配置をやり直したら、移動の取り消しは古い位置を指すので捨てる
      moveHistory.current = { undo: [], redo: [] };
      if (pins.size > 0) {
        placed = layoutResult.map((n) => {
          const p = pins.get(n.id);
          return p ? { ...n, position: p } : n;
        });
      }
    }
    if (anchorOnRelayout.current) {
      anchorOnRelayout.current = false;
      const { width, height, transform } = store.getState();
      const anchor = pickAnchor(nodesRef.current, selectionRef.current.at(-1), viewRect(width, height, transform));
      const moved = layoutResult.find((n) => n.id === anchor?.id);
      if (anchor && moved) {
        const dx = anchor.position.x - moved.position.x;
        const dy = anchor.position.y - moved.position.y;
        placed = placed.map((n) =>
          pins.has(n.id) ? n : { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } },
        );
        anchored = true;
      }
    }
    setNodes(
      placed.map((n) => ({
        ...n,
        selected: selectedRef.current.has(n.id),
        data: {
          ...n.data,
          onToggle: toggleTable,
          onColumnMenu: openColumnMenu,
          actions,
          inline: inlineFor(n.id, inlineRef.current.session, inlineRef.current.sessionError),
          focused: focusedRef.current.has(n.id),
        },
      })),
    );
    needsFit.current = !anchored && layoutResult.length > 0;
  }, [layoutResult, setNodes, toggleTable, openColumnMenu, actions, store, pinsNow]);
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const edit = inlineFor(n.id, session, sessionError);
        return n.data.inline === edit ? n : { ...n, data: { ...n.data, inline: edit } };
      }),
    );
  }, [session, sessionError, setNodes]);
  useEffect(() => {
    setDraftNode((d) =>
      d && session?.isNew ? { ...d, data: { ...d.data, draft: { ...session, error: sessionError }, showComments } } : d,
    );
  }, [session, sessionError, showComments]);
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) =>
        n.data.focused === focused.has(n.id) ? n : { ...n, data: { ...n.data, focused: focused.has(n.id) } },
      ),
    );
  }, [focused, setNodes]);
  // 1 テーブルずつの開閉は、位置はそのままで高さと中身だけを変える
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const compact = collapsed.has(n.id);
        return n.data.compact === compact
          ? n
          : { ...n, height: nodeHeight(compact, n.data.rows.length), data: { ...n.data, compact } };
      }),
    );
  }, [collapsed, setNodes]);
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.selected === selected.has(n.id) ? n : { ...n, selected: selected.has(n.id) })));
  }, [selected, setNodes]);

  // 図の上での選択（クリック、⌘ クリック、Shift ドラッグ）を受け取る。選んだ順は残す
  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const ids = new Set(picked.map((n) => n.id));
    setSelection((prev) => {
      const next = [...prev.filter((id) => ids.has(id)), ...[...ids].filter((id) => !prev.includes(id))];
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
  }, []);

  // 選んだテーブルにつながる FK の線を青くする。線はテーブルの下に描く（zIndex を上げない）。
  // 端は IE 記法で、始点（source）が子、終点（target）が親
  // 押して選んだリレーションの線（Delete で消す）。テーブルの選択とは別に持ち、テーブルや何もないところを押すと外す
  const [pickedEdges, setPickedEdges] = useState<string[]>([]);
  const edges = useMemo(() => {
    const picked = new Set(pickedEdges);
    return (data ? buildEdges(data, nodeIds, collapsed) : []).map((e) => {
      const isPicked = picked.has(e.id);
      const isSelected = isPicked || selected.has(e.source) || selected.has(e.target);
      const color: MarkerColor = isSelected ? 'selected' : 'default';
      return {
        ...e,
        type: edgeType,
        className: cn(e.className, isSelected && 'edge-selected', isPicked && 'edge-picked'),
        markerStart: e.data ? markerId(e.data.child, color) : undefined,
        markerEnd: e.data ? markerId(e.data.parent, color) : undefined,
      };
    });
  }, [data, nodeIds, collapsed, selected, edgeType, pickedEdges]);

  // 図を組み直したら、一覧で選んだテーブルがあればそこへ、無ければ全体が収まるように寄せる（一括の開閉では寄せない）。
  // テーブルが多いときは全体を収めると文字が読めないので、0.4 倍より小さくしない（はみ出した分は中央から外れる）。
  // React Flow が新しい配置を受け取った後（nodes が変わった後）に寄せないと、古い配置に合わせてしまう
  const pendingFocus = useRef<string>(undefined);
  useEffect(() => {
    if (!needsFit.current || nodes.length === 0) {
      return;
    }
    needsFit.current = false;
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    afterPane(() => {
      void (target
        ? fitView({ nodes: [{ id: target }], duration: 300, maxZoom: 0.7 })
        : fitView({ duration: 200, minZoom: 0.4, maxZoom: 1 }));
    });
  }, [nodes, fitView, afterPane]);

  // テーブルを図の中央に寄せる。倍率は変えない
  const centerOn = (id: string) =>
    afterPane(() => {
      const n = getInternalNode(id);
      if (!n) {
        return;
      }
      const { x, y } = n.internals.positionAbsolute;
      const w = n.measured.width ?? n.width ?? 0;
      const h = n.measured.height ?? n.height ?? 0;
      void setCenter(x + w / 2, y + h / 2, { zoom: getZoom(), duration: 300 });
    });

  // Shift で範囲を選ぶときの起点（最後に Shift なしで押したテーブル）
  const listAnchor = useRef<string>(undefined);

  // 一覧で Shift を押して押したら、起点から押したテーブルまで（一覧に出ている順）をまとめて選ぶ。
  // 押したテーブルを最後に置く（エディタに出す対象）。図に出ていないテーブルは図に足す
  const pickRange = (name: string, names: string[]) => {
    const from = names.indexOf(listAnchor.current ?? '');
    const to = names.indexOf(name);
    if (from < 0 || to < 0) {
      pick(name, false);
      return;
    }
    const range = from <= to ? names.slice(from, to + 1) : names.slice(to, from + 1).reverse();
    if (focus) {
      setSelection(range);
      setFocus({ tables: range, withRelated: focus.withRelated });
      return;
    }
    setSelection(range);
    setEditorOpen(true);
    const hidden = range.filter((n) => !visible.has(n));
    if (hidden.length > 0) {
      setShown((p) => new Set([...p, ...hidden]));
    }
  };

  // 一覧から選ぶ。図に出ていなければ図に足してから寄せる。⌘ / Ctrl を押していれば選択に足す（外す）
  const pick = (name: string, additive: boolean) => {
    listAnchor.current = name;
    // フォーカス中は、押したテーブルにフォーカスを移す。Shift などで押したらフォーカスに足す（入っていれば外す）
    if (focus) {
      let tables = [name];
      if (additive) {
        tables = focus.tables.includes(name)
          ? focus.tables.length > 1
            ? focus.tables.filter((n) => n !== name)
            : focus.tables
          : [...focus.tables, name];
      } else {
        setEditorOpen(true);
      }
      setSelection(tables);
      if (tables.length !== focus.tables.length || tables.some((n, i) => n !== focus.tables[i])) {
        setFocus({ tables, withRelated: focus.withRelated });
      }
      return;
    }
    // 選んでいるテーブルをさらに押したら、リレーションのあるテーブルだけを出す
    if (!additive && selection.length === 1 && selection[0] === name) {
      startFocus([name], true);
      return;
    }
    if (additive) {
      setSelection((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
    } else {
      setSelection([name]);
      setEditorOpen(true);
    }
    if (visible.has(name)) {
      // 図に出ているなら、配置は変えずにそのテーブルへ寄せる（⌘ / Ctrl で選択に足すときは寄せない）
      if (!additive) {
        afterPane(() => void fitView({ nodes: [{ id: name }], duration: 300, maxZoom: 0.7 }));
      }
    } else if (!focus) {
      // 図に出ていなければ図に足し、配置をやり直したあとで寄せる
      pendingFocus.current = name;
      setShown((p) => new Set(p).add(name));
    }
  };

  const showAll = () => {
    if (data) {
      setShown(new Set(allTableNames(data).filter(inFiles)));
    }
    setFocus(undefined);
  };

  const clearShown = () => {
    setShown(new Set());
    setSelection([]);
    setFocus(undefined);
  };

  const hideTables = (tables: string[]) => {
    setShown((p) => new Set([...p].filter((n) => !tables.includes(n))));
    setSelection((prev) => prev.filter((n) => !tables.includes(n)));
    setMenu(undefined);
  };

  // Esc かフォーカス中の札の × で、選択を外し、全テーブルを図に出して全体表示に戻る
  const backToAll = () => {
    setSelection([]);
    // 図から外していたテーブルも戻す
    if (data) {
      const all = allTableNames(data).filter(inFiles);
      if (!all.every((n) => shown.has(n))) {
        setShown(new Set(all));
      }
    }
    if (focus) {
      // フォーカスを解くと配置をやり直し、全体が収まるように寄せる
      setFocus(undefined);
    } else {
      afterPane(() => void fitView({ duration: 200, minZoom: 0.4, maxZoom: 1 }));
    }
  };
  const backToAllRef = useRef(backToAll);
  backToAllRef.current = backToAll;

  // フォーカスから 1 つ外す。最後の 1 つを外したら全体表示に戻る
  const removeFromFocus = (name: string) => {
    if (!focus) {
      return;
    }
    const tables = focus.tables.filter((n) => n !== name);
    if (tables.length === 0) {
      backToAll();
      return;
    }
    setFocus({ tables, withRelated: focus.withRelated });
    setSelection((prev) => prev.filter((n) => n !== name));
  };

  const startFocus = (tables: string[], withRelated: boolean) => {
    pinned.current.focus.clear();
    setFocus({ tables, withRelated });
    setMenu(undefined);
  };

  // 右クリックしたテーブルが選択に入っていればその選択全体、入っていなければそのテーブルだけを対象にする
  const openMenu = (e: ReactMouseEvent, id?: string) => {
    e.preventDefault();
    const tables = id && !selected.has(id) ? [id] : selection;
    if (id && !selected.has(id)) {
      setSelection([id]);
    }
    if (tables.length > 0) {
      setMenu({ x: e.clientX, y: e.clientY, tables });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return;
      }
      if (menu) {
        setMenu(undefined);
        return;
      }
      // 入力欄やエディタの中の Esc（検索を閉じるなど）では戻らない
      if (e.target instanceof Element && e.target.closest('input, textarea, select, .cm-editor')) {
        return;
      }
      backToAllRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // メニューの外を押したら閉じる。一覧の行からも開けるので、図の上のクリックだけでは閉じきれない
  useEffect(() => {
    if (!menu) {
      return;
    }
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest('[data-menu]'))) {
        setMenu(undefined);
      }
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [menu]);

  const primary = selection.at(-1);
  const primaryTable = data && primary ? findTable(data, primary) : undefined;
  // エディタに出すファイルとブロック。編集でテーブル名を変えて見失っても、同じファイルを出し続ける
  const lastTarget = useRef<EditorTarget>(undefined);
  const found: EditorTarget | undefined =
    data && primaryTable
      ? {
          name: primaryTable.name,
          file: primaryTable.range.file,
          line: primaryTable.range.line,
          endLine: primaryTable.range.endLine,
        }
      : undefined;
  const target = found ?? (Object.keys(editedFiles).length > 0 ? lastTarget.current : undefined);
  lastTarget.current = target;
  const primarySource = target && (editedFiles[target.file] ?? data?.files.find((f) => f.path === target.file)?.source);
  const editorRef = useRef<HclEditorHandle>(null);

  // 編集した中身をファイルに書く。構文エラーがあるあいだは書かない
  const save = async () => {
    // hosted ビルドではファイルに書けないので、変えたファイルをまとめて PR にする
    if (HOSTED) {
      if (!readOnly && Object.keys(editedFiles).some(isDirty) && !parseError) {
        setPrOpen(true);
      }
      return;
    }
    if (!target) {
      return;
    }
    const path = target.file;
    const content = editedFiles[path];
    const base = originals[path];
    if (content === undefined || !base || content === base.source || parseError?.file === path) {
      return;
    }
    try {
      const res = await saveFile(path, content, base.hash);
      if ('conflict' in res) {
        setSaveError('読み込んだあとでディスク上のファイルが変わったため、保存していません');
        return;
      }
      setSaveError(undefined);
      setOriginals((o) => ({ ...o, [path]: { source: content, hash: res.hash } }));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // ビジュアル側の操作を HCL に当てる。当てたあとの中身は編集中のファイルに入り、エディタ・図・差分に出る。
  // 保存はエディタの「保存」で行う。当てられなかったときは理由を返す
  const fileOf = (table: string) => data?.tables.find((t) => t.name === table)?.range.file;
  // center が false のときは、エディタがもう出ていれば表示位置を動かさない（続けて列を足すときなど）
  const applyEdit = async (
    path: string,
    op: EditOp | EditOp[],
    select?: string,
    center = true,
  ): Promise<string | undefined> => {
    if (readOnly) {
      return READ_ONLY_NOTICE;
    }
    try {
      const res = await editFile(path, editedFilesRef.current, Array.isArray(op) ? op : [op]);
      if ('parseError' in res) {
        setParseError(res.parseError);
        return `構文エラーを直してから編集してください（${res.parseError.file}:${res.parseError.line}）`;
      }
      const before = new Set(data?.tables.map((t) => t.name));
      const added = res.schema.tables.map((t) => t.name).filter((n) => !before.has(n));
      skipReparse.current = true;
      // 続けて当てる操作（線をまとめて消すなど）が、当てたあとの中身を使えるように先に入れておく
      editedFilesRef.current = { ...editedFilesRef.current, ...res.sources };
      setEditedFiles((f) => ({ ...f, ...res.sources }));
      setParseError(undefined);
      preserveLayout.current = true;
      setData(res.schema);
      if (added.length > 0) {
        setShown((p) => new Set([...p, ...added]));
      }
      if (select) {
        setSelection([select]);
        setEditorOpen(true);
        if (center || !editorVisible) {
          centerOn(select);
        }
      }
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  // スキーマ名 → それを宣言しているファイル（テーブルを足す先）
  const schemaFiles = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of data?.files ?? []) {
      for (const match of f.source.matchAll(/^schema\s+"([^"]+)"/gm)) {
        if (match[1] && !m.has(match[1])) {
          m.set(match[1], f.path);
        }
      }
    }
    return m;
  }, [data]);

  const editedFilesRef = useRef(editedFiles);
  editedFilesRef.current = editedFiles;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const draftNodeRef = useRef(draftNode);
  draftNodeRef.current = draftNode;
  const appliedNameRef = useRef(appliedName);
  appliedNameRef.current = appliedName;
  const sessionSeq = useRef(0);
  const sessionTimer = useRef<number>(undefined);
  // 最後に当てた内容。同じ内容は当て直さない
  const lastApplied = useRef<string>(undefined);
  const columnKey = useRef(0);
  const emptyColumn = (): DraftColumn => ({ key: ++columnKey.current, name: '', type: 'text', null: false });

  // 打っている内容を、打ち始める前の中身に当て直す。当てられなければ HCL は前に当てられた内容のまま、理由を出す
  const applySession = async (s: Session) => {
    const ops = sessionOps(s);
    const key = JSON.stringify([s.path, ops]);
    if (key === lastApplied.current) {
      // 前に当てた内容に戻ったときは、途中で当てられなかった理由を消す（待っている応答も捨てる）
      sessionSeq.current++;
      setSessionError(undefined);
      return;
    }
    const seq = ++sessionSeq.current;
    let res: Awaited<ReturnType<typeof editFile>>;
    try {
      res = await editFile(s.path, { ...editedFilesRef.current, [s.path]: s.base }, ops);
    } catch (e) {
      if (seq === sessionSeq.current) {
        setSessionError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (seq !== sessionSeq.current) {
      return;
    }
    if ('parseError' in res) {
      setParseError(res.parseError);
      setSessionError(`構文エラーを直してから編集してください（${res.parseError.file}:${res.parseError.line}）`);
      return;
    }
    lastApplied.current = key;
    setSessionError(undefined);
    const name = s.isNew ? s.name.trim() || undefined : undefined;
    const before = new Set(dataRef.current?.tables.map((t) => t.name));
    const added = res.schema.tables.map((t) => t.name).filter((n) => !before.has(n));
    const prevName = appliedNameRef.current;
    skipReparse.current = true;
    editedFilesRef.current = { ...editedFilesRef.current, ...res.sources };
    setEditedFiles((f) => ({ ...f, ...res.sources }));
    setParseError(undefined);
    preserveLayout.current = true;
    // 新しいテーブルは、空のテーブルを出している場所に置く
    const position = draftNodeRef.current?.position;
    if (name && position) {
      placeNew.current = { name, position };
    }
    dataRef.current = res.schema;
    setData(res.schema);
    setShown((p) => {
      const next = new Set([...p, ...added]);
      if (s.isNew && prevName && prevName !== name) {
        next.delete(prevName);
      }
      return next;
    });
    if (s.isNew) {
      appliedNameRef.current = name;
      setAppliedName(name);
      // エディタに、打っているテーブルを出す
      if (name) {
        setSelection([name]);
      }
    }
  };
  const applySessionRef = useRef(applySession);
  applySessionRef.current = applySession;

  // 打つのが止まってから当てる
  useEffect(() => {
    if (!session) {
      return;
    }
    sessionTimer.current = window.setTimeout(() => void applySessionRef.current(session), 200);
    return () => window.clearTimeout(sessionTimer.current);
  }, [session]);

  const startSession = (s: Omit<Session, 'base'>) => {
    const base = editedFilesRef.current[s.path] ?? dataRef.current?.files.find((f) => f.path === s.path)?.source ?? '';
    lastApplied.current = JSON.stringify([s.path, sessionOps({ ...s, base })]);
    setSessionError(undefined);
    setSession({ ...s, base });
    setEditorOpen(true);
  };

  // 打ち終える。accept は打った内容のまま、revert は打ち始める前の中身に戻す。
  // drop はエディタで直接書き換えたときで、当て直さない（エディタの中身を残す）
  const finishDraft = async (mode: 'accept' | 'revert' | 'drop') => {
    const s = sessionRef.current;
    if (!s) {
      return;
    }
    window.clearTimeout(sessionTimer.current);
    sessionRef.current = undefined;
    setSession(undefined);
    if (mode === 'accept') {
      await applySessionRef.current(s);
    } else if (mode === 'revert') {
      await applySessionRef.current({ ...s, name: s.isNew ? '' : s.name, columns: [], comment: undefined });
    } else {
      sessionSeq.current++;
    }
    const name = appliedNameRef.current;
    const position = draftNodeRef.current?.position;
    if (s.isNew && name && position) {
      setNodes((ns) => ns.map((n) => (n.id === name ? { ...n, position } : n)));
      pinsNow().set(name, position);
      setSelection([name]);
      // フォーカス中は、足したテーブルもフォーカスに入れて図に残す（ほかのテーブルの位置は変えない）
      if (focusRef.current && !focusRef.current.tables.includes(name)) {
        preserveLayout.current = true;
        placeNew.current = { name, position };
        setFocus({ ...focusRef.current, tables: [...focusRef.current.tables, name] });
      }
    }
    appliedNameRef.current = undefined;
    setAppliedName(undefined);
    setDraftNode(undefined);
    setSessionError(undefined);
    lastApplied.current = undefined;
  };

  const expand = (table: string) =>
    setCollapsed((prev) => {
      if (!prev.has(table)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(table);
      return next;
    });

  // ＋ で空のテーブルを出す。名前と列を打つと、そのまま HCL に入る
  const openAddTable = async () => {
    setMenu(undefined);
    if (readOnly) {
      setNotice(READ_ONLY_NOTICE);
      return;
    }
    await finishDraft('accept');
    const schemas = [...schemaFiles.keys()];
    const preferred = (primary && data?.tables.find((t) => t.name === primary)?.schema) || '';
    const schema = schemas.includes(preferred) ? preferred : (schemas[0] ?? '');
    const path = schemaFiles.get(schema);
    if (!path) {
      setNotice('schema ブロックのあるファイルがありません');
      return;
    }
    const { width, height, transform } = store.getState();
    const view = viewRect(width, height, transform);
    // エディタが出ると図が狭くなるので、狭くなったあとの中央に出す
    const paneWidth = editorVisible ? view.width : view.width - editorWidth / transform[2];
    const draft: Session = {
      isNew: true,
      name: '',
      schema,
      baseRows: [],
      pk: { name: 'id', type: 'serial' },
      columns: [emptyColumn()],
      path,
      base: '',
    };
    setDraftNode({
      id: DRAFT_ID,
      type: 'draft',
      position: { x: Math.round(view.x + paneWidth / 2 - 150), y: Math.round(view.y + view.height / 2 - 60) },
      selectable: false,
      data: { draft, schemas, actions, showComments },
    });
    startSession(draft);
  };

  // 既存のテーブルの下に、列を打つ行を出す
  const startAddColumn = async (table: string) => {
    setMenu(undefined);
    if (readOnly) {
      setNotice(READ_ONLY_NOTICE);
      return;
    }
    const cur = sessionRef.current;
    if (cur && !cur.isNew && cur.name === table) {
      return;
    }
    await finishDraft('accept');
    const t = dataRef.current && findTable(dataRef.current, table);
    const rows = nodesRef.current.find((n) => n.id === table)?.data.rows;
    if (!t || !rows) {
      return;
    }
    expand(table);
    setSelection([table]);
    startSession({
      isNew: false,
      name: table,
      schema: t.schema,
      path: t.range.file,
      baseRows: rows,
      columns: [emptyColumn()],
    });
  };

  // 吹き出しの中でコメントを書き換える。打つとそのまま HCL に入る
  const startComment = async (table: string, column?: string) => {
    setMenu(undefined);
    if (readOnly) {
      setNotice(READ_ONLY_NOTICE);
      return;
    }
    const cur = sessionRef.current;
    if (cur?.comment && cur.name === table && cur.comment.column === column) {
      return;
    }
    await finishDraft('accept');
    const t = dataRef.current && findTable(dataRef.current, table);
    const rows = nodesRef.current.find((n) => n.id === table)?.data.rows;
    if (!t || !rows) {
      return;
    }
    if (column) {
      expand(table);
    }
    const value = (column ? t.columns.find((c) => c.name === column)?.comment : t.comment) ?? '';
    setSelection([table]);
    startSession({
      isNew: false,
      name: table,
      schema: t.schema,
      path: t.range.file,
      baseRows: rows,
      columns: [],
      comment: { column, value },
    });
  };

  // スキーマを変えたら、今のファイルは打ち始める前に戻し、スキーマのあるファイルで打ち直す
  const setDraftSchema = async (schema: string) => {
    const s = sessionRef.current;
    const path = schemaFiles.get(schema);
    if (!s || !path) {
      return;
    }
    if (path === s.path) {
      setSession({ ...s, schema });
      return;
    }
    window.clearTimeout(sessionTimer.current);
    await applySessionRef.current({ ...s, name: '', columns: [] });
    const { base: _, ...rest } = s;
    startSession({ ...rest, schema, path });
  };

  actionsRef.current = {
    startAddColumn: (t) => void startAddColumn(t),
    startComment: (t, c) => void startComment(t, c),
    setDraftComment: (value) => setSession((s) => (s?.comment ? { ...s, comment: { ...s.comment, value } } : s)),
    setDraftName: (name) => setSession((s) => s && { ...s, name }),
    setDraftSchema: (schema) => void setDraftSchema(schema),
    // 末尾の空の行に打ったら、その下に次の空の行を足す
    setDraftColumn: (key, patch) =>
      setSession((s) => {
        if (!s) {
          return s;
        }
        const columns = s.columns.map((c) => (c.key === key ? { ...c, ...patch } : c));
        const last = columns.at(-1);
        return { ...s, columns: last && last.name !== '' ? [...columns, emptyColumn()] : columns };
      }),
    setDraftPk: (patch) => setSession((s) => (s?.pk ? { ...s, pk: { ...s.pk, ...patch } } : s)),
    finishDraft: (mode) => void finishDraft(mode),
  };

  // テーブルを消す。ほかのテーブルからそのテーブルへの FK と、そのテーブルの trigger も消える（保存するまではファイルに書かない）
  const deleteTables = async (tables: string[]) => {
    setMenu(undefined);
    await finishDraft('accept');
    const path = fileOf(tables[0] ?? '');
    if (!path) {
      return;
    }
    const err = await applyEdit(
      path,
      tables.map((table) => ({ kind: 'deleteTable', table })),
    );
    if (err) {
      setNotice(err);
      return;
    }
    const gone = new Set(tables);
    setSelection((prev) => prev.filter((n) => !gone.has(n)));
    setShown((p) => new Set([...p].filter((n) => !gone.has(n))));
    if (focus) {
      const rest = focus.tables.filter((n) => !gone.has(n));
      setFocus(rest.length > 0 ? { ...focus, tables: rest } : undefined);
    }
  };

  const deleteRelation = async (table: string, fk: string) => {
    setMenu(undefined);
    await finishDraft('accept');
    const path = fileOf(table);
    if (!path) {
      return;
    }
    setNotice(await applyEdit(path, { kind: 'deleteForeignKey', table, name: fk }));
  };

  // Delete / Backspace で、選んでいる線か、線を選んでいなければ選んでいるテーブルを消す（両方を一度には消さない）
  const deleteSelected = async () => {
    const picked = new Set(pickedEdges);
    const fks = new Map<string, { table: string; fk: string }>();
    for (const e of edges) {
      if (picked.has(e.id) && e.data?.table && e.data.fk) {
        fks.set(`${e.data.table}.${e.data.fk}`, { table: e.data.table, fk: e.data.fk });
      }
    }
    if (fks.size > 0) {
      setPickedEdges([]);
      await finishDraft('accept');
      // 同じファイルの FK はまとめて消す
      const byFile = new Map<string, EditOp[]>();
      for (const { table, fk } of fks.values()) {
        const path = fileOf(table);
        if (path) {
          byFile.set(path, [...(byFile.get(path) ?? []), { kind: 'deleteForeignKey', table, name: fk }]);
        }
      }
      for (const [path, ops] of byFile) {
        const err = await applyEdit(path, ops);
        if (err) {
          setNotice(err);
          return;
        }
      }
      return;
    }
    const tables = selectionRef.current.filter((n) => dataRef.current && findTable(dataRef.current, n));
    if (tables.length > 0) {
      await deleteTables(tables);
    }
  };
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      // 入力欄やエディタの中では、文字を消すだけ
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable], .cm-editor')) {
        return;
      }
      e.preventDefault();
      void deleteSelectedRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const columnTypes = useMemo(() => [...COLUMN_TYPES, ...(data?.enums.map((e) => `enum.${e.name}`) ?? [])], [data]);

  // 空のテーブルは React Flow の状態に入れず、ここで足す。動かした位置と測った大きさだけ受け取る
  const allNodes = useMemo<Node[]>(() => {
    const shownNodes = appliedName ? nodes.filter((n) => n.id !== appliedName) : nodes;
    return draftNode ? [...shownNodes, draftNode] : shownNodes;
  }, [nodes, draftNode, appliedName]);
  const onAllNodesChange = (changes: NodeChange[]) => {
    const own = changes.filter((c) => 'id' in c && c.id === DRAFT_ID);
    if (own.length > 0) {
      setDraftNode((d) => (d ? (applyNodeChanges(own, [d])[0] as Node<DraftNodeData> | undefined) : d));
    }
    onNodesChange(changes.filter((c) => !('id' in c && c.id === DRAFT_ID)) as NodeChange<Node<TableNodeData>>[]);
  };

  // 列の右の接続点から、相手の列の左の接続点まで引いたら FK を足す（引き始めた側が FK を持つ）
  const handleColumn = (handle: string | null | undefined, side: 'out' | 'in') =>
    handle?.endsWith(`-${side}`) && !handle.startsWith('table-') ? handle.slice(0, -side.length - 1) : undefined;
  const isValidConnection = (c: Edge | Connection) =>
    handleColumn(c.sourceHandle, 'out') !== undefined && handleColumn(c.targetHandle, 'in') !== undefined;
  const connect = async (c: Connection) => {
    await finishDraft('accept');
    const column = handleColumn(c.sourceHandle, 'out');
    const refColumn = handleColumn(c.targetHandle, 'in');
    const path = fileOf(c.source);
    if (!column || !refColumn || !path) {
      return;
    }
    const err = await applyEdit(
      path,
      { kind: 'addForeignKey', table: c.source, columns: [column], refTable: c.target, refColumns: [refColumn] },
      c.source,
    );
    setNotice(err);
  };
  const hasEditor = target !== undefined && primarySource !== undefined;
  // 図の幅が変わっている間は、寄せるのを待つ
  useEffect(
    () =>
      store.subscribe((state, prev) => {
        if (state.width !== prev.width && pendingMove.current) {
          window.clearTimeout(moveTimer.current);
          moveTimer.current = window.setTimeout(flushMove, 60);
        }
      }),
    [store, flushMove],
  );
  const editorVisible = hasEditor && editorOpen;
  // 幅をドラッグしているあいだは、開閉のアニメーションを止める
  const [resizing, setResizing] = useState(false);

  // 打つのが止まってから解析し直し、図と差分に反映する。構文エラーのあいだは前の図のまま
  const dataRef = useRef(data);
  dataRef.current = data;
  const editSeq = useRef(0);
  // ビジュアル側の編集は、サーバーが解析したスキーマを返すので、ここで解析し直さない
  const skipReparse = useRef(false);
  useEffect(() => {
    if (skipReparse.current) {
      skipReparse.current = false;
      return;
    }
    const d = dataRef.current;
    if (!d || Object.keys(editedFiles).length === 0) {
      return;
    }
    const seq = ++editSeq.current;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetchSchemaEdited(editedFiles);
        if (seq !== editSeq.current) {
          return;
        }
        if ('parseError' in res) {
          setParseError(res.parseError);
          return;
        }
        setParseError(undefined);
        preserveLayout.current = true;
        // エディタで足したテーブル（名前を変えたものも）は図に出す
        const before = new Set(d.tables.map((t) => t.name));
        const added = res.schema.tables.map((t) => t.name).filter((n) => !before.has(n));
        if (added.length > 0) {
          setShown((p) => new Set([...p, ...added]));
        }
        dataRef.current = res.schema;
        setData(res.schema);
      } catch (e) {
        if (seq === editSeq.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [editedFiles]);

  // 図のテーブルの移動を Ctrl+Z で取り消し、Ctrl+Shift+Z でやり直す（入力欄とエディタの中ではそれぞれの取り消し）
  const dragStart = useRef(new Map<string, XYPosition>());
  useEffect(() => {
    const apply = (moves: Move[], key: 'from' | 'to') => {
      const to = new Map(moves.map((m) => [m.id, m[key]]));
      for (const [id, p] of to) {
        pinsNow().set(id, p);
      }
      setNodes((ns) => ns.map((n) => (to.has(n.id) ? { ...n, position: to.get(n.id) ?? n.position } : n)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') {
        return;
      }
      if (e.target instanceof Element && e.target.closest('input, textarea, select, .cm-editor')) {
        return;
      }
      e.preventDefault();
      const h = moveHistory.current;
      const moves = (e.shiftKey ? h.redo : h.undo).pop();
      if (!moves) {
        return;
      }
      apply(moves, e.shiftKey ? 'to' : 'from');
      (e.shiftKey ? h.undo : h.redo).push(moves);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setNodes, pinsNow]);

  // エディタを出しているときは、Ctrl+F（⌘F）をエディタ内の検索、Ctrl+S（⌘S）を保存にする
  useEffect(() => {
    if (!editorVisible) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        editorRef.current?.openSearch();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorVisible]);

  // 別のテーブルを選んだら、閉じていたエディタを開き直す
  useEffect(() => {
    if (primary) {
      setEditorOpen(true);
    }
  }, [primary]);

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const move = (ev: PointerEvent) => setEditorWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const allCollapsed = nodeIds.size > 0 && [...nodeIds].every((n) => collapsed.has(n));
  const tableNames = useMemo(() => (data ? allTableNames(data).filter(inFiles) : []), [data, inFiles]);
  const filteredNames = tableNames.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase()));

  // 一覧の目のボタン。名前のクリックと違い、選択も画面の位置も変えない
  const toggleShown = (name: string) => {
    if (visible.has(name)) {
      hideTables([name]);
    } else {
      setShown((p) => new Set(p).add(name));
    }
  };

  const toggleFile = (path: string) =>
    setFiles((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });

  const renderTableItem = (name: string) => (
    <ListRow
      key={name}
      name={name}
      onCanvas={visible.has(name)}
      selected={selected.has(name)}
      primary={name === primary}
      canToggle={!focus}
      onPick={(e) => (e.shiftKey ? pickRange(name, filteredNames) : pick(name, e.metaKey || e.ctrlKey))}
      onFocusRelated={() => {
        setSelection([name]);
        startFocus([name], true);
      }}
      onToggleShown={() => toggleShown(name)}
      onContextMenu={(e) => openMenu(e, name)}
    />
  );

  return (
    <div className="relative flex h-screen overflow-hidden bg-background text-sm text-foreground">
      <aside className="flex w-72 shrink-0 flex-col gap-5 overflow-x-hidden overflow-y-auto border-r bg-sidebar p-3">
        {error && <p className="break-all text-xs text-destructive">{error}</p>}

        {data && (
          <section className="grid min-w-0 gap-1.5">
            <h2 className={sectionTitle}>ファイル</h2>
            <ul className="flex flex-col gap-px">
              {data.files.map((f) => {
                const on = files.has(f.path);
                return (
                  <li key={f.path}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={on}
                      className={cn(fileItem, !on && listRowOff)}
                      onClick={() => toggleFile(f.path)}
                    >
                      <FileCode2 className={cn('size-3.5', on && 'text-muted-foreground')} />
                      <span className="min-w-0 flex-1 truncate text-left">{f.path}</span>
                      {isDirty(f.path) && <DirtyDot />}
                      {on ? (
                        <Eye className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                      ) : (
                        <EyeOff className="size-3.5" />
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {data && (
          <section className="grid min-w-0 gap-1.5">
            <div className="flex items-center gap-1">
              <h2 className={cn(sectionTitle, 'flex-1')}>テーブル</h2>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[13px]" onClick={showAll}>
                すべて
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[13px]" onClick={clearShown}>
                クリア
              </Button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="テーブル名で絞り込む"
                value={query}
                placeholder="絞り込む"
                className="h-8 bg-background pl-8 text-[13px]"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <ul className="flex flex-col gap-px">{filteredNames.map(renderTableItem)}</ul>
          </section>
        )}
      </aside>

      <main className={cn('relative min-w-0 flex-1', connecting && 'erd-connecting')}>
        <ColumnTypesContext.Provider value={columnTypes}>
          <ReactFlow
            nodes={allNodes}
            onNodesChange={onAllNodesChange}
            edges={edges}
            nodeTypes={nodeTypes}
            onSelectionChange={onSelectionChange}
            onNodeClick={(e, n) => {
              // テーブルの中の入力欄やボタンを押したときは、選ぶ・寄せるをしない
              if (
                n.id === DRAFT_ID ||
                (e.target instanceof Element && e.target.closest('input, select, textarea, button'))
              ) {
                return;
              }
              setPickedEdges([]);
              const s = sessionRef.current;
              if (s && !(!s.isNew && s.name === n.id)) {
                void finishDraft('accept');
              }
              setEditorOpen(true);
              const additive = e.metaKey || e.ctrlKey || e.shiftKey;
              // 選んでいるテーブルをさらに押したら、リレーションのあるテーブルだけを出す
              const prev = selectionRef.current;
              if (!additive && prev.length === 1 && prev[0] === n.id) {
                startFocus([n.id], true);
                return;
              }
              // エディタが出て図の幅が決まってから、押したテーブルを中央に寄せる
              if (!additive) {
                centerOn(n.id);
              }
            }}
            onNodeDragStart={(_, __, dragged) => {
              dragStart.current = new Map(dragged.map((n) => [n.id, n.position]));
            }}
            onNodeDragStop={(_, __, dragged) => {
              const moves = dragged.flatMap((n) => {
                if (n.id === DRAFT_ID) {
                  return [];
                }
                const from = dragStart.current.get(n.id);
                return from && (from.x !== n.position.x || from.y !== n.position.y)
                  ? [{ id: n.id, from, to: n.position }]
                  : [];
              });
              if (moves.length > 0) {
                moveHistory.current.undo.push(moves);
                moveHistory.current.redo = [];
                for (const m of moves) {
                  pinsNow().set(m.id, m.to);
                }
              }
            }}
            onNodeDoubleClick={(e, n) => {
              if (
                n.id === DRAFT_ID ||
                (e.target instanceof Element && e.target.closest('input, select, textarea, button'))
              ) {
                return;
              }
              setSelection([n.id]);
              startFocus([n.id], true);
            }}
            onEdgeClick={(e, edge) => {
              setMenu(undefined);
              const additive = e.metaKey || e.ctrlKey || e.shiftKey;
              setPickedEdges((prev) =>
                additive
                  ? prev.includes(edge.id)
                    ? prev.filter((id) => id !== edge.id)
                    : [...prev, edge.id]
                  : [edge.id],
              );
            }}
            onEdgeContextMenu={(e, edge) => {
              e.preventDefault();
              setPickedEdges([edge.id]);
              const d = edge.data as { table?: string; fk?: string } | undefined;
              if (d?.table && d.fk) {
                setMenu({ x: e.clientX, y: e.clientY, tables: [], edge: { table: d.table, fk: d.fk } });
              }
            }}
            onNodeContextMenu={(e, n) => (n.id === DRAFT_ID ? e.preventDefault() : openMenu(e, n.id))}
            onSelectionContextMenu={(e) => openMenu(e)}
            onPaneClick={() => {
              setMenu(undefined);
              setPickedEdges([]);
              void finishDraft('accept');
            }}
            onMoveStart={() => setMenu(undefined)}
            zoomOnDoubleClick={false}
            // Backspace / Delete は自前で受ける（テーブルは HCL から消し、線は FK を消す）
            deleteKeyCode={null}
            minZoom={0.05}
            nodesConnectable={!readOnly}
            isValidConnection={isValidConnection}
            onConnect={(c) => void connect(c)}
            onConnectStart={() => setConnecting(true)}
            onConnectEnd={() => setConnecting(false)}
            snapToGrid
            snapGrid={[GRID, GRID]}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Lines} gap={GRID} color="var(--app-grid)" />
            <Markers />
            <Panel position="top-left">
              <div className="flex items-center gap-1 rounded-lg border bg-background p-1 shadow-sm">
                <Tip label={allCollapsed ? 'すべて開く' : 'すべて畳む'}>
                  <Toggle
                    size="sm"
                    aria-label="すべて畳む"
                    pressed={allCollapsed}
                    onPressedChange={(on) => {
                      anchorOnRelayout.current = true;
                      setCollapsed(on && data ? new Set(allTableNames(data)) : new Set());
                      setLayoutVersion((v) => v + 1);
                    }}
                  >
                    <IconTableHeader />
                  </Toggle>
                </Tip>
                {!readOnly && (
                  <Tip label="テーブルを追加">
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => void openAddTable()}>
                      <Plus />
                      <span className="sr-only">テーブルを追加</span>
                    </Button>
                  </Tip>
                )}
                <Tip label="コメントを表示">
                  <Toggle
                    size="sm"
                    aria-label="コメントを表示"
                    pressed={showComments}
                    onPressedChange={(on) => {
                      // 幅が変わるので並べ直す。画面の位置は保つ
                      anchorOnRelayout.current = true;
                      setShowComments(on);
                    }}
                  >
                    <MessageSquareText />
                  </Toggle>
                </Tip>

                <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />

                <ToggleGroup
                  type="single"
                  size="sm"
                  aria-label="線の形"
                  value={edgeType}
                  onValueChange={(v) => {
                    if (v) {
                      setEdgeType(v as EdgeType);
                    }
                  }}
                >
                  {EDGE_TYPES.map(([type, label]) => {
                    const EdgeIcon = EDGE_ICONS[type];
                    return (
                      <Tip key={type} label={label}>
                        <ToggleGroupItem value={type} aria-label={label}>
                          <EdgeIcon />
                        </ToggleGroupItem>
                      </Tip>
                    );
                  })}
                </ToggleGroup>

                {focus && (
                  <>
                    <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
                    {/* フォーカスしているテーブルを全部並べる。図では同じ青の枠で囲む */}
                    <div className="flex max-w-[min(60vw,720px)] flex-wrap items-center gap-1" aria-live="polite">
                      <Crosshair className="mx-0.5 size-3.5 shrink-0 text-[#0969da]" />
                      {focus.tables.map((t) => (
                        <span
                          key={t}
                          className="inline-flex h-6 max-w-56 items-center gap-0.5 rounded-md border border-[#0969da]/30 bg-[#0969da]/5 pr-0.5 pl-1.5 font-mono text-[13px] text-[#0969da]"
                        >
                          <span className="truncate">{t}</span>
                          <button
                            type="button"
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-[#0969da]/15 focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() => removeFromFocus(t)}
                          >
                            <X className="size-3" />
                            <span className="sr-only">{t} をフォーカスから外す</span>
                          </button>
                        </span>
                      ))}
                    </div>
                    <Tip label="解除">
                      <Button variant="ghost" size="icon" className="size-8" onClick={backToAll}>
                        <X />
                        <span className="sr-only">フォーカスを解除</span>
                      </Button>
                    </Tip>
                  </>
                )}
              </div>
            </Panel>
            {HOSTED && data && (
              <Panel position="top-right">
                <HostedBar
                  dirtyFiles={Object.keys(editedFiles)
                    .filter(isDirty)
                    .map((path) => ({ path, content: editedFiles[path] ?? '' }))}
                  hasParseError={parseError !== undefined}
                  open={prOpen}
                  onOpenChange={setPrOpen}
                  onSubmitted={(done) => {
                    setSaveError(undefined);
                    setOriginals((o) => ({
                      ...o,
                      ...Object.fromEntries(done.map((f) => [f.path, { source: f.content, hash: '' }])),
                    }));
                  }}
                />
              </Panel>
            )}
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={minimapColor} />
          </ReactFlow>
        </ColumnTypesContext.Provider>
        {menu && (
          <div
            data-menu
            className="fixed z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.edge ? (
              <button
                type="button"
                className={cn(menuItem, 'text-destructive [&_svg]:text-destructive')}
                onClick={() => menu.edge && void deleteRelation(menu.edge.table, menu.edge.fk)}
              >
                <Trash2 />
                リレーションを削除
              </button>
            ) : menu.column ? (
              <button
                type="button"
                className={menuItem}
                onClick={() => void startComment(menu.tables[0] ?? '', menu.column)}
              >
                <MessageSquareText />
                コメントを編集
              </button>
            ) : (
              <>
                <button type="button" className={menuItem} onClick={() => startFocus(menu.tables, true)}>
                  <Crosshair />
                  リレーションテーブルを表示
                </button>
                <button type="button" className={menuItem} onClick={() => startFocus(menu.tables, false)}>
                  <FocusIcon />
                  このテーブルのみ表示
                </button>
                {!focus && (
                  <button type="button" className={menuItem} onClick={() => hideTables(menu.tables)}>
                    <EyeOff />
                    図から外す
                  </button>
                )}
                {focus && (
                  <button
                    type="button"
                    className={menuItem}
                    onClick={() => {
                      setMenu(undefined);
                      backToAll();
                    }}
                  >
                    <X />
                    解除
                  </button>
                )}
                {menu.tables.length === 1 && (
                  <>
                    <div className="-mx-1 my-1 h-px bg-border" />
                    <button
                      type="button"
                      className={menuItem}
                      onClick={() => void startAddColumn(menu.tables[0] ?? '')}
                    >
                      <Plus />
                      列を追加
                    </button>
                    <button type="button" className={menuItem} onClick={() => void startComment(menu.tables[0] ?? '')}>
                      <MessageSquareText />
                      コメントを編集
                    </button>
                  </>
                )}
                <div className="-mx-1 my-1 h-px bg-border" />
                <button
                  type="button"
                  className={cn(menuItem, 'text-destructive [&_svg]:text-destructive')}
                  onClick={() => void deleteTables(menu.tables)}
                >
                  <Trash2 />
                  テーブルを削除
                </button>
              </>
            )}
          </div>
        )}
        {notice && (
          <div
            className="absolute bottom-4 left-1/2 z-20 flex max-w-lg -translate-x-1/2 items-start gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive shadow-md"
            role="status"
          >
            <span className="break-words">{notice}</span>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setNotice(undefined)}
            >
              <X className="size-4" />
              <span className="sr-only">閉じる</span>
            </button>
          </div>
        )}
        {data && nodeIds.size === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-muted-foreground">
            テーブルがありません
          </p>
        )}
      </main>

      {/* 何も選んでいないときも幅 0 で置いておき、最初に選んだときも右から出す。中は shadcn のダークテーマ */}
      <aside
        className={cn(
          'dark relative shrink-0 overflow-hidden border-l bg-background text-foreground transition-[width] duration-200 ease-out',
          !hasEditor && 'border-l-0',
          resizing && 'transition-none',
        )}
        style={{ width: hasEditor ? (editorOpen ? editorWidth : COLLAPSED_EDITOR_WIDTH) : 0 }}
      >
        {hasEditor && target && primarySource !== undefined && (
          <>
            {!editorOpen && (
              <button
                type="button"
                className="absolute inset-0 z-10 flex justify-center bg-card pt-3 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                title="開く"
                onClick={() => setEditorOpen(true)}
              >
                <ChevronLeft className="size-4" />
                <span className="sr-only">エディタを開く</span>
              </button>
            )}
            {/* 中身の幅は固定し、外側の幅だけを動かして右から出し入れする */}
            <div className="flex h-full flex-col" style={{ width: editorWidth }} inert={!editorOpen}>
              <button
                type="button"
                className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize outline-none hover:bg-ring/50 focus-visible:bg-ring/50"
                aria-label="エディタの幅"
                onPointerDown={startResize}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    setEditorWidth((w) => clampWidth(w + (e.key === 'ArrowLeft' ? 20 : -20)));
                  }
                }}
              />
              <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-card px-3">
                <FileCode2 className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate font-mono text-sm font-medium">{target.file}</span>
                {isDirty(target.file) && (
                  <>
                    <Tip label="差分">
                      <Toggle size="sm" className="size-7 min-w-7 p-0" pressed={showDiff} onPressedChange={setShowDiff}>
                        <GitCompare />
                        <span className="sr-only">差分</span>
                      </Toggle>
                    </Tip>
                    <Tip label={HOSTED ? 'PR を作成（⌘S）' : '保存（⌘S）'}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={HOSTED ? parseError !== undefined : parseError?.file === target.file}
                        onClick={() => void save()}
                      >
                        {HOSTED ? <GitPullRequest /> : <Save />}
                        <span className="sr-only">{HOSTED ? 'PR を作成' : '保存'}</span>
                      </Button>
                    </Tip>
                  </>
                )}
                <Tip label="畳む">
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditorOpen(false)}>
                    <ChevronRight />
                    <span className="sr-only">エディタを畳む</span>
                  </Button>
                </Tip>
              </div>
              <HclEditor
                ref={editorRef}
                path={target.file}
                source={primarySource}
                line={target.line}
                endLine={target.endLine}
                scrollKey={target.name}
                editable={!readOnly}
                errorLine={parseError?.file === target.file ? parseError.line : undefined}
                onEdit={(doc) => {
                  // 図の上で打っている途中なら、そこで打ち終える（打ち始める前の中身がエディタの中身と食い違うため）
                  void finishDraft('drop');
                  setEditedFiles((f) => ({ ...f, [target.file]: doc }));
                }}
                schema={data}
                original={originals[target.file]?.source}
                showDiff={showDiff && isDirty(target.file)}
              />
              {saveError && (
                <div
                  className="flex gap-2 border-t border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs break-words text-destructive"
                  role="status"
                >
                  {saveError}
                </div>
              )}
              {parseError?.file === target.file && (
                <div
                  className="flex gap-2 border-t border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs break-words text-destructive"
                  role="status"
                >
                  {parseError.line > 0 && <span className="shrink-0 font-mono">{parseError.line}</span>}
                  {parseError.message}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// 選択中は色を付けず濃いグレーにする。minimap は CSS 変数を読めないので値を直接書く
function minimapColor(n: Node<TableNodeData>): string {
  return n.selected ? '#737373' : '#d9d9d9';
}

function DirtyDot() {
  return <span className="size-1.5 shrink-0 rounded-full bg-amber-400" title="未保存の変更あり" />;
}

type ListRowProps = {
  name: string;
  onCanvas: boolean;
  selected: boolean;
  // エディタに出している（最後に選んだ）テーブル
  primary: boolean;
  // フォーカス中は図に出すテーブルをフォーカスが決めるので、目のボタンを出さない
  canToggle: boolean;
  onPick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  // ダブルクリック。そのテーブルとリレーションのあるテーブルだけを図に出す
  onFocusRelated: () => void;
  onToggleShown: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
};

// テーブル一覧の 1 行。背景は選択だけに使い、図に出ているかは文字色と目のアイコンで示す。
// 図に出ていない行は薄い文字で閉じた目を常に出し、出ている行は hover したときだけ目を出す
function ListRow({
  name,
  onCanvas,
  selected,
  primary,
  canToggle,
  onPick,
  onFocusRelated,
  onToggleShown,
  onContextMenu,
}: ListRowProps) {
  const EyeIcon = onCanvas ? Eye : EyeOff;
  const eyeLabel = onCanvas ? '図から外す' : '図に出す';
  return (
    <li
      className={cn(listRow, selected ? listRowSelected : 'hover:bg-accent', !onCanvas && listRowOff)}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        aria-pressed={selected}
        className={cn(listName, primary && 'font-medium')}
        onClick={onPick}
        onDoubleClick={onFocusRelated}
      >
        <span className="truncate">{name}</span>
      </button>
      {canToggle && (
        <Tip label={eyeLabel}>
          <button
            type="button"
            aria-pressed={onCanvas}
            className={cn(eyeButton, onCanvas && eyeButtonOnCanvas)}
            onClick={onToggleShown}
          >
            <EyeIcon className="size-3.5" />
            <span className="sr-only">{eyeLabel}</span>
          </button>
        </Tip>
      )}
    </li>
  );
}

const sectionTitle = 'px-2 text-[13px] font-medium text-muted-foreground';
// relative は sr-only の文字を行の中に収めるため（収めないと一覧の外にはみ出して、ページが縦に伸びる）。
// select-none は Shift で範囲を選ぶときに、ブラウザが文字まで選ばないようにするため
const listRow = 'group relative flex h-8 min-w-0 items-center rounded-md text-foreground select-none';
// 選んだ行は、テーブルの見出しと同じ淡い青の背景で示す
const listRowSelected = 'bg-app-accent-light';
// 図に出ていない（ファイルを外している）行
const listRowOff = 'text-app-gray-5';
const listName =
  'flex h-full min-w-0 flex-1 items-center rounded-md px-2 text-left font-mono text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
const eyeButton =
  'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-app-gray-4/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';
const eyeButtonOnCanvas = 'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';
const fileItem = 'group h-8 w-full justify-start px-2 font-mono text-[13px] font-normal text-foreground';
const menuItem =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground';
