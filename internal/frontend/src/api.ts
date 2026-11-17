import { HOSTED } from './hosted/config';
import * as hosted from './hosted/transport';
import type { Schema } from './types';

export type ParseError = { file: string; line: number; message: string };

// 作業ツリーの db/schema を読む。hosted ビルドでは、組み込み先の API とブラウザの WASM が代わりをする（下の 2 つも同じ）
export async function fetchSchema(): Promise<Schema> {
  if (HOSTED) {
    return hosted.fetchSchema();
  }
  const res = await fetch('/_/api/schema');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as Schema;
}

// 編集中のファイル（パス → 中身）で差し替えて解析する。構文エラーなら parseError を返す
export async function fetchSchemaEdited(
  overrides: Record<string, string>,
): Promise<{ schema: Schema } | { parseError: ParseError }> {
  if (HOSTED) {
    return hosted.fetchSchemaEdited(overrides);
  }
  const res = await fetch('/_/api/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides }),
  });
  if (res.status === 422) {
    const body = (await res.json()) as { parseError: ParseError };
    return { parseError: body.parseError };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return { schema: (await res.json()) as Schema };
}

// 編集した中身をファイルに書く。base は読み込んだときの中身のハッシュ。ディスクが変わっていれば conflict を返す
export async function saveFile(
  path: string,
  content: string,
  base: string,
): Promise<{ hash: string } | { conflict: true }> {
  const res = await fetch('/_/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, base }),
  });
  if (res.status === 409) {
    return { conflict: true };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { hash: string };
}

export type EditOp =
  // name / type は主キーの列（空なら id serial）
  | { kind: 'addTable'; table: string; schema: string; name?: string; type?: string; comment?: string }
  | { kind: 'addColumn'; table: string; name: string; type: string; null: boolean; default?: string; comment?: string }
  | { kind: 'addForeignKey'; table: string; columns: string[]; refTable: string; refColumns: string[] }
  | { kind: 'setComment'; table: string; column?: string; comment: string }
  // テーブルを消すと、ほかのテーブルからそのテーブルへの FK と、そのテーブルの trigger も消える
  | { kind: 'deleteTable'; table: string }
  | { kind: 'deleteForeignKey'; table: string; name: string };

// 画面の操作を順に HCL に当てる。ファイルには書かず、変わったファイルの中身と解析したスキーマを返す
export async function editFile(
  path: string,
  overrides: Record<string, string>,
  ops: EditOp[],
): Promise<{ sources: Record<string, string>; schema: Schema } | { parseError: ParseError }> {
  if (HOSTED) {
    return hosted.editFile(path, overrides, ops);
  }
  const res = await fetch('/_/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, overrides, ops }),
  });
  if (res.status === 422) {
    const body = (await res.json()) as { parseError: ParseError };
    return { parseError: body.parseError };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { sources: Record<string, string>; schema: Schema };
}
