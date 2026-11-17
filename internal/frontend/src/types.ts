// Go の internal/schema と internal/server が返す JSON の型。

export type Range = { file: string; start: number; end: number; line: number; endLine: number };

export type Column = { name: string; type: string; null: boolean; default?: string; comment?: string; range: Range };

export type ForeignKey = {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate?: string;
  onDelete?: string;
  range: Range;
};

export type Index = { name: string; columns: string[]; unique?: boolean; type?: string; where?: string; range: Range };

export type Table = {
  name: string;
  schema: string;
  comment?: string;
  range: Range;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  indexes: Index[];
  uniques: Index[];
};

export type Enum = { name: string; schema: string; values: string[]; range: Range };

export type SourceFile = { path: string; source: string; hash: string };

export type Schema = { tables: Table[]; enums: Enum[]; files: SourceFile[] };
