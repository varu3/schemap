// ローカルのビルドでは、vite.config.ts がこの読み込み先を engine.stub.ts に差し替える（Worker と WASM を取り込まないため）
import { callEngine, type EngineResult } from '@/hosted/engine';
import type { EditOp, ParseError } from '../api';
import type { Schema } from '../types';
import { apiUrl, currentRef, type HostedGithub, type HostedMeta, setHostedMeta } from './config';

type BaseFile = { path: string; source: string };

// 読み込んだときの中身。ローカルのサーバーではディスクの中身に当たり、編集中の中身はここに重ねて解析する
let baseFiles: BaseFile[] = [];

function errorOf(body: unknown, status: number): Error {
  const msg = (body as { error?: string } | undefined)?.error;
  if (msg) {
    return new Error(msg);
  }
  // 成功のステータスなのに決めた形でない（ログインの画面に送られたなど）
  return new Error(status < 400 ? '応答を読めません。ページを読み込み直してください' : `HTTP ${status}`);
}

function schemaOf(res: EngineResult): { schema: Schema } | { parseError: ParseError } {
  if (res.status === 422) {
    return { parseError: (res.body as { parseError: ParseError }).parseError };
  }
  if (res.status !== 200) {
    throw errorOf(res.body, res.status);
  }
  return { schema: res.body as Schema };
}

// 組み込み先の API から、選んだブランチの今の中身を読む
export async function fetchSchema(): Promise<Schema> {
  const ref = currentRef();
  const res = await fetch(apiUrl(`/schema${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`), {
    headers: { Accept: 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as HostedMeta & { files: BaseFile[]; error?: string };
  // ログインが切れていると、ログインの画面（HTML）が 200 で返る。JSON の形まで確かめる
  if (!res.ok || !Array.isArray(body.files) || typeof body.sha !== 'string') {
    throw errorOf(body, res.status);
  }
  const { files, ...meta } = body;
  baseFiles = files;
  setHostedMeta(meta);
  const parsed = schemaOf(await callEngine('parse', { files }));
  if ('parseError' in parsed) {
    const e = parsed.parseError;
    throw new Error(`${e.file}:${e.line} ${e.message}`);
  }
  return parsed.schema;
}

export async function fetchSchemaEdited(
  overrides: Record<string, string>,
): Promise<{ schema: Schema } | { parseError: ParseError }> {
  return schemaOf(await callEngine('parse', { files: baseFiles, overrides }));
}

export async function editFile(
  path: string,
  overrides: Record<string, string>,
  ops: EditOp[],
): Promise<{ sources: Record<string, string>; schema: Schema } | { parseError: ParseError }> {
  const res = await callEngine('edit', { files: baseFiles, path, overrides, ops });
  if (res.status === 422) {
    return { parseError: (res.body as { parseError: ParseError }).parseError };
  }
  if (res.status !== 200) {
    throw errorOf(res.body, res.status);
  }
  return res.body as { sources: Record<string, string>; schema: Schema };
}

export type PullRequestInput = {
  // 読み込んだコミット。新しいブランチはここから切る
  baseSha: string;
  // 前に作った PR のブランチ。あれば、そのブランチにコミットを足す
  branch?: string;
  title: string;
  body: string;
  // 変えたファイルの、ファイル全体の中身
  files: { path: string; content: string }[];
};

export type PullRequest = { url: string; number: number; branch: string };

// 組み込み先が付ける CSRF のクッキー（XSRF-TOKEN）を、そのままヘッダーで返す
function xsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

// 変えたファイルを新しいブランチにコミットして PR を作る。
// 本人の GitHub アカウントとの連携が要るときは authorizeUrl を返す（連携してから、もう一度呼ぶ）
export async function createPullRequest(input: PullRequestInput): Promise<PullRequest | { authorizeUrl: string }> {
  const res = await fetch(apiUrl('/pull-requests'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<PullRequest> & { error?: string; authorizeUrl?: string };
  if (res.status === 401 && body.authorizeUrl) {
    return { authorizeUrl: body.authorizeUrl };
  }
  if (!res.ok || typeof body.url !== 'string' || typeof body.number !== 'number' || typeof body.branch !== 'string') {
    throw errorOf(body, res.status);
  }
  return { url: body.url, number: body.number, branch: body.branch };
}

// 連携の画面を別のウィンドウで開き、閉じるのを待つ。連携の画面は終わると schemap:github-linked を送って閉じる。
// 連携できたかは、呼び出し側がもう一度 PR を作ってみて確かめる（GitHub を経由すると window.opener が切れて、
// 知らせが届かないことがあるため、届かなくても失敗にしない）
export function linkGithub(authorizeUrl: string): Promise<HostedGithub | undefined> {
  if (!authorizeUrl.startsWith('/') || authorizeUrl.startsWith('//')) {
    return Promise.reject(new Error('連携の URL が正しくありません'));
  }
  const popup = window.open(authorizeUrl, 'schemap-github', 'popup,width=640,height=760');
  if (!popup) {
    return Promise.reject(new Error('GitHub との連携の画面を開けません。ポップアップを許可してください'));
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; github?: HostedGithub; error?: string } | undefined;
      if (e.origin !== window.location.origin || d?.type !== 'schemap:github-linked') {
        return;
      }
      done();
      if (d.error) {
        reject(new Error(d.error));
      } else {
        resolve(d.github);
      }
    };
    const timer = window.setInterval(() => {
      if (popup.closed) {
        done();
        resolve(undefined);
      }
    }, 500);
    window.addEventListener('message', onMessage);
  });
}
