import { Graph, layout } from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { ForeignKey, Schema, Table } from './types';

export type ColumnRow = {
  name: string;
  type: string;
  null: boolean;
  pk: boolean;
  fk: boolean;
  comment?: string;
};

// 打っている途中の列。名前が空の列は HCL に入れない
export type DraftColumn = { key: number; name: string; type: string; null: boolean };

// 打っている途中のテーブル（新しく足すテーブル、または列を足している既存のテーブル）。
// 打つたびに、打ち始める前の HCL にこの内容を当て直す
export type TableDraft = {
  isNew: boolean;
  // 新しいテーブルは打っている名前、既存のテーブルはその名前
  name: string;
  schema: string;
  // 打ち始める前からある列（新しいテーブルでは空）
  baseRows: ColumnRow[];
  // 新しいテーブルの主キーの列
  pk?: { name: string; type: string };
  // コメントを書き換えているときの、書き換える先（column が無ければテーブル）と打っている中身
  comment?: { column?: string; value: string };
  // 足している列。末尾はいつも空の行（次の列を打つ行）
  columns: DraftColumn[];
  error?: string;
};

export type InlineEdit =
  | { kind: 'columns'; draft: TableDraft }
  | { kind: 'comment'; column?: string; value: string; error?: string };

// テーブルの部品から呼ぶ操作。打った中身は、打つのが止まるたびに HCL に当てる
export type TableActions = {
  startAddColumn: (table: string) => void;
  startComment: (table: string, column?: string) => void;
  setDraftComment: (value: string) => void;
  setDraftName: (name: string) => void;
  setDraftSchema: (schema: string) => void;
  setDraftColumn: (key: number, patch: Partial<Omit<DraftColumn, 'key'>>) => void;
  setDraftPk: (patch: Partial<{ name: string; type: string }>) => void;
  // revert は打ち始める前の中身に戻す
  finishDraft: (mode: 'accept' | 'revert') => void;
};

export type DraftNodeData = {
  draft: TableDraft;
  schemas: string[];
  showComments?: boolean;
  actions: TableActions;
};

export type TableNodeData = {
  name: string;
  schema: string;
  comment?: string;
  rows: ColumnRow[];
  compact?: boolean;
  onToggle?: (name: string) => void;
  // 列の行を右クリックしたとき（コメントの編集などのメニューを出す）
  onColumnMenu?: (table: string, column: string, e: MouseEvent) => void;
  // その場で入力している内容（列の追加、コメントの編集）。App が持ち、テーブルごとに渡す
  inline?: InlineEdit;
  actions?: TableActions;
  showComments?: boolean;
  // フォーカスしているテーブル（リレーションで一緒に出ているだけのテーブルとは分けて示す）
  focused?: boolean;
};

// 背景のグリッドの間隔。テーブルの位置もこの倍数にそろえる。
export const GRID = 20;

const NODE_WIDTH = 320;
// コメントを常に出すときは、名前・コメント・型が並ぶように幅を広げる
const NODE_WIDTH_WITH_COMMENTS = 480;
const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 26;

export function findTable(schema: Schema, name: string): Table | undefined {
  return schema.tables.find((t) => t.name === name);
}

export function allTableNames(schema: Schema): string[] {
  return schema.tables.map((t) => t.name).sort();
}

function tableView(schema: Schema, name: string): TableNodeData | undefined {
  const table = findTable(schema, name);
  if (!table) {
    return undefined;
  }
  const fkColumns = new Set(table.foreignKeys.flatMap((fk) => fk.columns));
  const rows: ColumnRow[] = table.columns.map((c) => ({
    name: c.name,
    type: c.type,
    null: c.null,
    pk: table.primaryKey.includes(c.name),
    fk: fkColumns.has(c.name),
    comment: c.comment,
  }));
  return { name, schema: table.schema, comment: table.comment, rows };
}

function foreignKeys(schema: Schema, name: string): ForeignKey[] {
  return findTable(schema, name)?.foreignKeys ?? [];
}

// relatedTables は name と、name と FK で直接つながるテーブル（参照する側・される側の両方）。
export function relatedTables(schema: Schema, name: string): Set<string> {
  const related = new Set<string>([name]);
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      if (t.name === name) {
        related.add(fk.refTable);
      }
      if (fk.refTable === name) {
        related.add(t.name);
      }
    }
  }
  return related;
}

// 曲線は React Flow の 'default'（ベジェ曲線）。
export type EdgeType = 'default' | 'step' | 'straight';

export function nodeHeight(compact: boolean, rows: number): number {
  return compact ? HEADER_HEIGHT : HEADER_HEIGHT + rows * ROW_HEIGHT;
}

// テーブルのコメントの吹き出し（TableNode.tsx の TableBubble）の高さの見積もり。
// 並べるときにこの分を見出しの上に空け、吹き出しがほかのテーブルに重ならないようにする。
// 文字幅は 13px の文字で全角 13px・半角 8px、折り返しは最大幅 400px から左右の余白を引いた 376px として数える
const BUBBLE_TEXT_WIDTH = 376;
const BUBBLE_LINE_HEIGHT = 21.2;
// 上下の余白 12px・枠 2px・見出しとの間 8px
const BUBBLE_CHROME = 22;

export function bubbleHeight(text: string | undefined): number {
  if (!text) {
    return 0;
  }
  let lines = 1;
  let x = 0;
  for (const ch of text) {
    if (ch === '\n') {
      lines++;
      x = 0;
      continue;
    }
    const w = /[\x20-\x7e]/.test(ch) ? 8 : 13;
    if (x + w > BUBBLE_TEXT_WIDTH) {
      lines++;
      x = 0;
    }
    x += w;
  }
  return Math.ceil(lines * BUBBLE_LINE_HEIGHT + BUBBLE_CHROME);
}

// layoutNodes は表示するテーブルを dagre で並べる。collapsed に入っているテーブルは見出しだけの高さで並べる。
export function layoutNodes(
  schema: Schema,
  visible: Set<string>,
  collapsed: Set<string>,
  showComments = false,
): Node<TableNodeData>[] {
  const width = showComments ? NODE_WIDTH_WITH_COMMENTS : NODE_WIDTH;
  const g = new Graph();
  const allCompact = [...visible].every((n) => collapsed.has(n));
  // 列の間隔（ranksep）は変えない。一括の開閉で横方向にずれないようにする
  g.setGraph({ rankdir: 'LR', nodesep: allCompact ? 20 : 40, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  const views = new Map<string, TableNodeData>();
  for (const name of visible) {
    const v = tableView(schema, name);
    if (v) {
      v.compact = collapsed.has(name);
      views.set(name, v);
      v.showComments = showComments;
      const bubble = showComments ? bubbleHeight(v.comment) : 0;
      g.setNode(name, { width, height: nodeHeight(v.compact, v.rows.length) + bubble });
    }
  }
  for (const name of views.keys()) {
    for (const fk of foreignKeys(schema, name)) {
      if (views.has(fk.refTable)) {
        g.setEdge(name, fk.refTable);
      }
    }
  }

  layout(g);
  return [...views.values()].map((v) => {
    const pos = g.node(v.name);
    const height = nodeHeight(v.compact ?? false, v.rows.length);
    // dagre には吹き出しの分を足した高さで並べさせたので、テーブルはその下側に置く
    const bubble = showComments ? bubbleHeight(v.comment) : 0;
    return {
      id: v.name,
      type: 'table',
      position: { x: snap(pos.x - width / 2), y: snap(pos.y - (height + bubble) / 2 + bubble) },
      // 大きさを先に渡しておくと、描画前でも fitView がそのテーブルに寄せられる
      width,
      height,
      // コメントの吹き出しを出すテーブルは手前に描き、吹き出しがほかのテーブルに隠れないようにする
      zIndex: showComments && v.comment ? 1 : 0,
      data: v,
    };
  });
}

// 線の端の形（IE 記法）。zeroMany: 0 以上、zeroOne: 0 か 1、one: 必ず 1
export type End = 'zeroMany' | 'zeroOne' | 'one';

// table と fk は線を消すときに使う（FK を持つテーブルと、その FK の名前）
export type EdgeData = { child: End; parent: End; table?: string; fk?: string };

// cardinality は FK 1 本の両端の形を決める。
// 子（FK を持つ側）は、FK の列が PK か UNIQUE なら 0 か 1、それ以外は 0 以上。
// 親（参照される側）は、FK の列がすべて NOT NULL なら必ず 1、NULL を許す列があれば 0 か 1。
function cardinality(table: Table, fk: ForeignKey): EdgeData {
  const cols = [...fk.columns].sort().join(',');
  const sameColumns = (c: string[]) => [...c].sort().join(',') === cols;
  const unique =
    sameColumns(table.primaryKey) ||
    table.uniques.some((u) => sameColumns(u.columns)) ||
    table.indexes.some((i) => i.unique && !i.where && sameColumns(i.columns));
  const nullable = fk.columns.some((c) => table.columns.find((col) => col.name === c)?.null ?? false);
  return { child: unique ? 'zeroOne' : 'zeroMany', parent: nullable ? 'zeroOne' : 'one' };
}

// buildEdges は FK の線を作る。畳んだテーブルの側は見出しにつなぐ。
// どちらかの端が畳まれていれば FK 1 本につき線 1 本、両端とも開いていれば列ごとに 1 本。
export function buildEdges(schema: Schema, visible: Set<string>, collapsed: Set<string>): Edge<EdgeData>[] {
  const edges: Edge<EdgeData>[] = [];
  for (const name of visible) {
    const table = findTable(schema, name);
    if (!table) {
      continue;
    }
    for (const fk of table.foreignKeys) {
      if (!visible.has(fk.refTable)) {
        continue;
      }
      const common = {
        source: name,
        target: fk.refTable,
        data: { ...cardinality(table, fk), table: name, fk: fk.name },
      };
      const srcCollapsed = collapsed.has(name);
      const dstCollapsed = collapsed.has(fk.refTable);
      if (srcCollapsed || dstCollapsed) {
        edges.push({
          ...common,
          id: `${name}.${fk.name}`,
          sourceHandle: srcCollapsed ? 'table-out' : `${fk.columns[0] ?? ''}-out`,
          targetHandle: dstCollapsed ? 'table-in' : `${fk.refColumns[0] ?? ''}-in`,
        });
        continue;
      }
      fk.columns.forEach((col, i) => {
        edges.push({
          ...common,
          id: `${name}.${fk.name}.${i}`,
          sourceHandle: `${col}-out`,
          targetHandle: `${fk.refColumns[i] ?? ''}-in`,
        });
      });
    }
  }
  return edges;
}

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}
