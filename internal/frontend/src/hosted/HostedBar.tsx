import { ExternalLink, GitBranch, GitPullRequest, Lock, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Tip } from '@/components/Tip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type HostedGithub, hostedMeta, switchRef } from './config';
import { createPullRequest, linkGithub, type PullRequest } from './transport';

type Props = {
  // PR にまだ入れていない、変えたファイル（ファイル全体の中身）
  dirtyFiles: { path: string; content: string }[];
  // 構文エラーがあるあいだは PR にしない
  hasParseError: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // PR に入れ終えたファイル。呼び出し側は、これを保存済みの中身として扱う
  onSubmitted: (files: { path: string; content: string }[]) => void;
};

const DEFAULT_TITLE = 'db/schema: テーブル定義を変更';

// 図の右上に出す、ブランチの切り替えと PR の作成。hosted ビルドだけが使う
export function HostedBar({ dirtyFiles, hasParseError, open, onOpenChange, onSubmitted }: Props) {
  const meta = hostedMeta();
  // 前に作った PR。続けて変えた分は、同じ PR のブランチにコミットを足す
  const [pr, setPr] = useState<PullRequest>();
  const [github, setGithub] = useState<HostedGithub | undefined>(meta?.github);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!meta) {
    return null;
  }
  const dirty = dirtyFiles.length > 0;
  const needsLink = github?.required === true && !github.linked;

  const pickRef = (name: string) => {
    if (!name || name === meta.ref) {
      return;
    }
    if (dirty && !window.confirm('PR にしていない変更は失われます。ブランチを切り替えますか？')) {
      return;
    }
    switchRef(name);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !dirty || hasParseError) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const input = { baseSha: meta.sha, branch: pr?.branch, title: title.trim(), body, files: dirtyFiles };
      let res = await createPullRequest(input);
      if ('authorizeUrl' in res) {
        const linked = await linkGithub(res.authorizeUrl);
        res = await createPullRequest(input);
        if ('authorizeUrl' in res) {
          throw new Error('GitHub と連携できませんでした。もう一度試してください');
        }
        setGithub(linked ?? { required: true, linked: true });
      }
      setPr(res);
      onSubmitted(dirtyFiles);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const action = pr ? 'PR を更新' : 'PR を作成';
  return (
    <>
      <div className="flex items-center gap-1 rounded-lg border bg-background p-1 shadow-sm">
        <GitBranch className="mx-1 size-3.5 text-muted-foreground" />
        <ToggleGroup type="single" size="sm" aria-label="ブランチ" value={meta.ref} onValueChange={pickRef}>
          {meta.refs.map((r) => (
            <Tip key={r.name} label={r.editable ? `${r.name}（編集できる）` : `${r.name}（読むだけ）`}>
              <ToggleGroupItem value={r.name} aria-label={r.name} className="px-2 font-mono text-[13px]">
                {r.name}
              </ToggleGroupItem>
            </Tip>
          ))}
        </ToggleGroup>
        <Tip label={`${meta.repository} の ${meta.sha}`}>
          <span className="px-1 font-mono text-xs text-muted-foreground">{meta.sha.slice(0, 7)}</span>
        </Tip>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        {meta.editable ? (
          <Button
            variant={dirty ? 'default' : 'ghost'}
            size="sm"
            className="h-8"
            disabled={!dirty || hasParseError}
            onClick={() => onOpenChange(true)}
          >
            <GitPullRequest />
            {action}
            {dirty && <span className="font-mono text-xs opacity-80">{dirtyFiles.length}</span>}
          </Button>
        ) : (
          <span className="flex h-8 items-center gap-1 px-2 text-[13px] text-muted-foreground">
            <Lock className="size-3.5" />
            読み取り専用
          </span>
        )}
        {pr && (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex h-8 items-center gap-1 rounded-md px-2 font-mono text-[13px] text-[#0969da] hover:bg-accent"
          >
            #{pr.number}
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {open && meta.editable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            className="grid w-full max-w-lg gap-3 rounded-lg border bg-background p-4 shadow-lg"
            onSubmit={(e) => void submit(e)}
          >
            <div className="flex items-center gap-2">
              <GitPullRequest className="size-4 text-muted-foreground" />
              <h2 className="flex-1 text-base font-medium">{action}</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                <X />
                <span className="sr-only">閉じる</span>
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              {pr ? (
                <>
                  <span className="font-mono">{pr.branch}</span> にコミットを足します。
                </>
              ) : (
                <>
                  <span className="font-mono">{meta.repository}</span> の <span className="font-mono">{meta.ref}</span>
                  （<span className="font-mono">{meta.sha.slice(0, 7)}</span>
                  ）から新しいブランチを切り、<span className="font-mono">{meta.ref}</span> への PR を作ります。
                </>
              )}
            </p>
            <label className="grid gap-1 text-[13px]" htmlFor="schemap-pr-title">
              {pr ? 'コミットメッセージ' : 'タイトル'}
              <Input
                id="schemap-pr-title"
                value={title}
                maxLength={200}
                required
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            {!pr && (
              <label className="grid gap-1 text-[13px]" htmlFor="schemap-pr-body">
                説明
                <textarea
                  id="schemap-pr-body"
                  value={body}
                  rows={4}
                  maxLength={10000}
                  disabled={busy}
                  className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
            )}
            <ul className="grid gap-0.5 font-mono text-[13px]">
              {dirtyFiles.map((f) => (
                <li key={f.path} className="truncate">
                  {f.path}
                </li>
              ))}
            </ul>
            {needsLink && (
              <p className="text-[13px] text-muted-foreground">
                PR は自分の GitHub アカウントで作ります。押すと GitHub との連携の画面が開きます。
              </p>
            )}
            {github?.linked && github.login && (
              <p className="text-[13px] text-muted-foreground">
                <span className="font-mono">{github.login}</span> として作ります。
              </p>
            )}
            {error && (
              <p className="text-[13px] break-words text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                やめる
              </Button>
              <Button type="submit" disabled={busy || !dirty || hasParseError || title.trim() === ''}>
                {busy ? '作成中…' : needsLink ? `GitHub と連携して${action}` : action}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
