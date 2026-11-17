import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from '@codemirror/autocomplete';
import type { Schema } from './types';

// Atlas HCL の入力候補。カーソルが今どのブロックの中にいるかを、手前の文章から数えて決める。

type Block = { type: string; label?: string; from: number };

// blockStack はカーソルより手前で開いたまま閉じていないブロックを、外側から順に返す。
// 文字列・コメント・ヒアドキュメントの中の括弧は数えない。
function blockStack(text: string): Block[] {
  const stack: Block[] = [];
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      lineStart = i + 1;
      i++;
    } else if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
      i++;
    } else if (ch === '<' && text[i + 1] === '<') {
      const m = /^<<-?([A-Za-z_]\w*)/.exec(text.slice(i, i + 64));
      if (!m) {
        i += 2;
        continue;
      }
      const end = new RegExp(`\\n\\s*${m[1]}\\s*(\\n|$)`).exec(text.slice(i));
      i = end ? i + end.index + end[0].length : text.length;
      lineStart = i;
    } else if (ch === '{') {
      const header = text.slice(lineStart, i);
      const m = /^\s*([A-Za-z_]\w*)\s*(?:"([^"]*)")?/.exec(header);
      stack.push({ type: m?.[1] ?? '', label: m?.[2], from: i });
      i++;
    } else if (ch === '}') {
      stack.pop();
      i++;
    } else {
      i++;
    }
  }
  return stack;
}

export const COLUMN_TYPES = [
  'serial',
  'bigserial',
  'integer',
  'bigint',
  'smallint',
  'numeric',
  'numeric(10,2)',
  'real',
  'double_precision',
  'boolean',
  'text',
  'character_varying(255)',
  'varchar(255)',
  'char(1)',
  'uuid',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'json',
  'jsonb',
  'bytea',
  'inet',
  'sql("integer[]")',
];

const REF_ACTIONS = ['RESTRICT', 'CASCADE', 'NO_ACTION', 'SET_NULL', 'SET_DEFAULT'];

const SNIPPETS: Record<string, Completion> = {
  table: snippetCompletion(
    'table "${name}" {\n\tschema = schema.${public}\n\tcolumn "id" {\n\t\ttype = serial\n\t}\n\tprimary_key {\n\t\tcolumns = [column.id]\n\t}\n}',
    { label: 'table', type: 'keyword' },
  ),
  column: snippetCompletion('column "${name}" {\n\ttype = ${text}\n}', { label: 'column', type: 'keyword' }),
  primary_key: snippetCompletion('primary_key {\n\tcolumns = [column.${id}]\n}', {
    label: 'primary_key',
    type: 'keyword',
  }),
  foreign_key: snippetCompletion(
    'foreign_key "${name}" {\n\tcolumns     = [column.${}]\n\tref_columns = [table.${}.column.${id}]\n\ton_update   = RESTRICT\n\ton_delete   = RESTRICT\n}',
    { label: 'foreign_key', type: 'keyword' },
  ),
  index: snippetCompletion('index "${name}" {\n\tcolumns = [column.${}]\n}', { label: 'index', type: 'keyword' }),
  unique: snippetCompletion('unique "${name}" {\n\tcolumns = [column.${}]\n}', { label: 'unique', type: 'keyword' }),
  check: snippetCompletion('check "${name}" {\n\texpr = "${}"\n}', { label: 'check', type: 'keyword' }),
  on: snippetCompletion('on {\n\tcolumn = column.${}\n}', { label: 'on', type: 'keyword' }),
  enum: snippetCompletion('enum "${name}" {\n\tschema = schema.${public}\n\tvalues = ["${}"]\n}', {
    label: 'enum',
    type: 'keyword',
  }),
  schema: snippetCompletion('schema "${name}" {}', { label: 'schema', type: 'keyword' }),
  trigger: snippetCompletion(
    'trigger "${name}" {\n\ton = table.${}\n\tbefore {\n\t\tupdate = true\n\t}\n\tfor = ROW\n\texecute {\n\t\tfunction = function.${}\n\t}\n}',
    { label: 'trigger', type: 'keyword' },
  ),
  function: snippetCompletion(
    'function "${name}" {\n\tschema = schema.${public}\n\tlang   = PLpgSQL\n\treturn = trigger\n\tas     = <<-SQL\n\t${}\n\tSQL\n}',
    { label: 'function', type: 'keyword' },
  ),
  before: snippetCompletion('before {\n\t${update} = true\n}', { label: 'before', type: 'keyword' }),
  after: snippetCompletion('after {\n\t${insert} = true\n}', { label: 'after', type: 'keyword' }),
  execute: snippetCompletion('execute {\n\tfunction = function.${}\n}', { label: 'execute', type: 'keyword' }),
};

// ブロックの中に書けるブロックと属性。'' はトップレベル
const BLOCKS: Record<string, string[]> = {
  '': ['table', 'enum', 'schema', 'function', 'trigger'],
  table: ['column', 'primary_key', 'foreign_key', 'index', 'unique', 'check'],
  index: ['on'],
  trigger: ['before', 'after', 'execute'],
};

const ATTRS: Record<string, string[]> = {
  table: ['schema', 'comment'],
  column: ['type', 'null', 'default', 'comment'],
  primary_key: ['columns'],
  foreign_key: ['columns', 'ref_columns', 'on_update', 'on_delete'],
  index: ['columns', 'unique', 'type', 'where', 'comment'],
  unique: ['columns'],
  check: ['expr'],
  on: ['column', 'expr', 'ops', 'desc'],
  enum: ['schema', 'values', 'comment'],
  schema: ['comment'],
  trigger: ['on', 'for'],
  before: ['insert', 'update', 'delete'],
  after: ['insert', 'update', 'delete'],
  execute: ['function'],
  function: ['schema', 'lang', 'return', 'as'],
};

function keyword(label: string): Completion {
  return { label, type: 'constant' };
}

function names(text: string, block: string): string[] {
  return [...text.matchAll(new RegExp(`^\\s*${block}\\s+"([^"]+)"`, 'gm'))].map((m) => m[1] ?? '');
}

// 今いる table ブロックの列。解析済みのスキーマの列に、まだ解析されていない打ちかけの列を足す
function currentColumns(schema: Schema | undefined, text: string, stack: Block[]): string[] {
  const table = [...stack].reverse().find((b) => b.type === 'table');
  if (!table) {
    return [];
  }
  const fromSchema = schema?.tables.find((t) => t.name === table.label)?.columns.map((c) => c.name) ?? [];
  return [...new Set([...fromSchema, ...names(text.slice(table.from), 'column')])];
}

function schemaNames(schema: Schema | undefined, doc: string): string[] {
  return [...new Set([...(schema?.tables.map((t) => t.schema) ?? []), ...names(doc, 'schema')])];
}

function valueOptions(attr: string, schema: Schema | undefined, doc: string, cols: string[]): Completion[] {
  switch (attr) {
    case 'type':
      return [
        ...COLUMN_TYPES.map((t) => ({ label: t, type: 'type' })),
        ...(schema?.enums ?? []).map((e) => ({ label: `enum.${e.name}`, type: 'enum' })),
      ];
    case 'null':
    case 'unique':
    case 'desc':
    case 'insert':
    case 'update':
    case 'delete':
      return ['true', 'false'].map(keyword);
    case 'on_update':
    case 'on_delete':
      return REF_ACTIONS.map(keyword);
    case 'for':
      return ['ROW', 'STATEMENT'].map(keyword);
    case 'schema':
      return schemaNames(schema, doc).map((s) => ({ label: `schema.${s}`, type: 'variable' }));
    case 'default':
      return ['sql("now()")', 'true', 'false', '0', '""'].map(keyword);
    case 'columns':
    case 'column':
      return cols.map((c) => ({ label: `column.${c}`, type: 'property' }));
    case 'ref_columns':
    case 'on':
      return (schema?.tables ?? []).map((t) => ({ label: `table.${t.name}`, type: 'class' }));
    case 'function':
      return names(doc, 'function').map((f) => ({ label: `function.${f}`, type: 'function' }));
    case 'lang':
      return ['PLpgSQL', 'SQL'].map(keyword);
    case 'return':
      return ['trigger'].map(keyword);
    default:
      return [];
  }
}

export function atlasCompletion(getSchema: () => Schema | undefined) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const doc = ctx.state.doc.toString();
    const before = doc.slice(0, ctx.pos);
    const stack = blockStack(before);
    const current = stack.at(-1)?.type ?? '';
    const schema = getSchema();
    const line = ctx.state.doc.lineAt(ctx.pos);
    const lineBefore = line.text.slice(0, ctx.pos - line.from);

    // table.<名前>.column. の後ろは、そのテーブルの列
    const ref = /\btable\.(\w+)\.column\.(\w*)$/.exec(lineBefore);
    if (ref) {
      const cols = schema?.tables.find((t) => t.name === ref[1])?.columns ?? [];
      return {
        from: ctx.pos - (ref[2]?.length ?? 0),
        options: cols.map((c) => ({ label: c.name, type: 'property' })),
        validFor: /^\w*$/,
      };
    }
    // column. / table. / enum. / schema. / function. の後ろは、それぞれの名前
    const dot = /\b(column|table|enum|schema|function)\.(\w*)$/.exec(lineBefore);
    if (dot) {
      const kind = dot[1];
      let list: string[] = [];
      if (kind === 'column') {
        list = currentColumns(schema, before, stack);
      } else if (kind === 'table') {
        list = schema?.tables.map((t) => t.name) ?? [];
      } else if (kind === 'enum') {
        list = schema?.enums.map((e) => e.name) ?? [];
      } else if (kind === 'schema') {
        list = schemaNames(schema, doc);
      } else {
        list = names(doc, 'function');
      }
      return {
        from: ctx.pos - (dot[2]?.length ?? 0),
        options: list.map((n) => ({ label: n, type: kind === 'table' ? 'class' : 'property' })),
        validFor: /^\w*$/,
      };
    }

    // 属性 = の後ろは、その属性に書ける値
    const value = /^\s*(\w+)\s*=\s*\[?\s*(?:[\w.]+\s*,\s*)*([\w."()]*)$/.exec(lineBefore);
    if (value) {
      const options = valueOptions(value[1] ?? '', schema, doc, currentColumns(schema, before, stack));
      if (options.length === 0) {
        return null;
      }
      return { from: ctx.pos - (value[2]?.length ?? 0), options, validFor: /^[\w."()]*$/ };
    }

    // 行の頭は、今いるブロックの中に書けるブロックと属性
    const head = /^\s*(\w*)$/.exec(lineBefore);
    if (head && (head[1] !== '' || ctx.explicit)) {
      const blocks = (BLOCKS[current] ?? []).map((b) => SNIPPETS[b] ?? { label: b, type: 'keyword' });
      const attrs = (ATTRS[current] ?? []).map((a) => ({ label: a, type: 'property', apply: `${a} = ` }));
      if (blocks.length + attrs.length === 0) {
        return null;
      }
      return { from: ctx.pos - (head[1]?.length ?? 0), options: [...blocks, ...attrs], validFor: /^\w*$/ };
    }
    return null;
  };
}
