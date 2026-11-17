# schemap

Atlas HCL を読んで ER 図をブラウザに出し、右側のエディタで HCL を書き換えて図に反映するローカルツール。

```bash
schemap path/to/db/schema               # ディレクトリを渡すと中の *.hcl を読む
schemap db/schema/main.hcl              # ファイルを指定する（複数可）
schemap db/schema -port 6281 -no-open   # ポートを変える、ブラウザを開かない（フラグはパスの前後どちらでもよい）
```

読むファイルかディレクトリの指定は必須。既定では `127.0.0.1` だけで待ち受ける。`-host 0.0.0.0` のように loopback 以外で待ち受けると、localhost 以外の Host でも開けるようになり、ブラウザも開かない（コンテナで公開するとき）。そのときは誰でも編集して保存できるので、見られても困らないスキーマだけを置く。

## 入手

[Releases](https://github.com/varu3/schemap/releases) からプラットフォームに合うものを落とす。

```bash
gh release download -R varu3/schemap -p 'schemap_darwin_arm64.tar.gz'
tar -xzf schemap_darwin_arm64.tar.gz && ./schemap_darwin_arm64/schemap path/to/db/schema
```

コンテナイメージ（linux/amd64・linux/arm64）は `ghcr.io/varu3/schemap` にある。何も渡さなければサンプルの EC サイト（`examples/ec`）を開き、8080 番で待ち受ける。

```bash
docker run --rm -p 8080:8080 ghcr.io/varu3/schemap
docker run --rm -p 8080:8080 -v "$PWD/db/schema:/home/nonroot/schema" ghcr.io/varu3/schemap schema   # 手元のスキーマを開く
```

## できること・できないこと

- 図を見る: テーブル・列・PK・FK（IE 記法）・インデックス・enum。テーブルごとに列を畳む、一括で畳む
- テーブルを選ぶと寄せる。さらに押す（ダブルクリック）とリレーションのあるテーブルだけを出す。Shift で複数をフォーカスに足す。Esc で全体に戻る。左の一覧では Shift で範囲をまとめて選ぶ（⌘ / Ctrl で 1 つずつ足す）
- 右側のエディタで HCL を編集すると、図に反映する。`{` `[` `"` は閉じる側も入り、Atlas のブロック・属性・型・テーブル名・列名を候補に出す
- 編集したら「差分」でディスク上の中身との違いを確かめ、「保存」（⌘S / Ctrl+S）でファイルに書く。読み込んだあとでディスクのファイルが変わっていたら保存しない。構文エラーがあるあいだも保存しない
- テーブル名と列名にマウスを乗せると、HCL の `comment` を出す。コメントを常に吹き出しで出すこともできる
- 図の上で HCL に書き足す。ツールバーの ＋ で空のテーブルが出る。テーブル名・主キーの列名・列名を打ち、型を選ぶと、そのまま HCL に入る（Enter は次の欄へ移るだけ。主キーは既定で `id serial`、列は既定で `text` の必須）。「必須」を押すと NULL を許す列に切り替わる。見出しの ＋ や右クリックの「列を追加」で、既存のテーブルの下に列を打つ行が出る。何もないところを押すと打ち終え、Esc で打ち始める前に戻す。吹き出しを押す（右クリックの「コメントを編集」）と、コメントもその場で打ち換えられ、そのまま HCL に入る。列の右の点から相手の列の左の点まで引くと FK を足す。足した内容はエディタに入り、保存するまではファイルに書かない
- 手で動かしたテーブルと図の上で足したテーブルは、配置をやり直しても（一覧でテーブルを図に出し入れする、ファイルを切り替える、コメントの表示を切り替える、フォーカスを解くなど）同じ場所に残る。フォーカス中に動かした位置は、フォーカスを解くと捨てる。読み込み直すと消える
- 図の上で HCL から消す。テーブルの右クリックの「テーブルを削除」で、テーブルと、ほかのテーブル（ほかのファイルも含む）からそのテーブルへの FK、そのテーブルの trigger を消す。リレーションの線の右クリックの「リレーションを削除」で、その FK を消す。テーブルや線を選んで Delete（Backspace）でも消せる（線を選んでいるときは線だけを消す）。保存するまではファイルに書かない
- trigger と function は図に出さない

HCL の式は評価せず、書かれた文字のまま表示する（`type = varchar(255)`、`default = sql("now()")` など）。Atlas の CLI と作業用 DB は使わないため、HCL の書き間違いのうち構文以外はここでは見つからない。

## ほかのアプリに組み込む（hosted ビルド）

同じ画面を、ファイルを置けないサーバー（ほかの Web アプリの中のページ）に組み込むための形。ローカルの `schemap` の動きは変わらない。違いは次の 3 つだけ。

- ファイルは組み込み先の API から読む。図の右上でブランチを切り替える（切り替えると読み直す）
- HCL の解析と編集は、Go のサーバーの代わりにブラウザの WASM（`cmd/wasm`）が行う。組み込み先は Go を動かさない
- 「保存」の代わりに「PR を作成」。変えたファイルをまとめて組み込み先に送り、組み込み先が PR を作る。続けて変えた分は同じ PR に足す。読むだけのブランチでは編集の入口を止める

```bash
mise run build-hosted   # internal/frontend/dist-hosted に index.html・assets・schemap.wasm・wasm_exec.js を作る
```

`dist-hosted` の中身をそのまま同じオリジンで配り、`index.html?api=<API のパス>&ref=<ブランチ>` を開く（iframe でよい）。`api` には同じオリジンのパスだけを指定できる。Release には `schemap_hosted.tar.gz` として置く。

組み込み先が用意する API（JSON）:

| | |
|---|---|
| `GET <api>/schema?ref=` | `{ ref, sha, editable, refs: [{ name, editable }], repository, github: { required, linked, login }, files: [{ path, source }] }`。`ref` を省くと既定のブランチ |
| `POST <api>/pull-requests` | `{ baseSha, branch?, title, body, files: [{ path, content }] }` → `{ url, number, branch }`。`baseSha` は読み込んだコミット（`sha`）、`branch` は前の応答のブランチ（同じ PR に足すとき）。CSRF は `XSRF-TOKEN` のクッキーを `X-XSRF-TOKEN` ヘッダーで返す。本人の GitHub 連携が要るときは 401 と `{ authorizeUrl }` を返す。画面はそれを別のウィンドウで開き、`{ type: "schemap:github-linked", github }` の `postMessage` を待ってからやり直す |

エラーはどちらも `{ error }` で返す。

## 構成

Go のバイナリ 1 つに画面を取り込む（構成は [k1LoW/mo](https://github.com/k1LoW/mo) にならった）。

| パス | 中身 |
|---|---|
| `main.go` | 起動 |
| `internal/schema` | HCL の解析（`hashicorp/hcl/v2`）。`testdata` によく使う書き方を集めた HCL を置く |
| `internal/edit` | 図の上の操作（テーブル・列・FK・コメントの追加と書き換え）を HCL に当てる。書き換える場所の前後のバイトは変えない |
| `internal/source` | 引数のファイル・ディレクトリ（中の `*.hcl`）を読む |
| `internal/engine` | ファイルの中身からの解析と、操作を順に当てる処理（ファイルをまたぐ確認を含む）。ファイルは読み書きしない。`internal/server` と `cmd/wasm` が使う |
| `cmd/wasm` | `internal/engine` をブラウザで動かす WASM の入口（hosted ビルド用） |
| `internal/server` | 画面の配信と API（`GET /_/api/schema`、編集中の中身で解析し直す `POST /_/api/schema`、保存の `POST /_/api/save`、図の上の操作を順に当てる `POST /_/api/edit`）。POST は自分の画面からのものだけ受け付ける |
| `internal/static` | 画面のビルド結果を `embed` で取り込む |
| `internal/frontend` | 画面（React + TypeScript + React Flow + dagre + CodeMirror、shadcn/ui + Tailwind CSS、Vite でビルド） |
| `examples/ec` | サンプルの EC サイトのスキーマ（商品・会員・注文の 17 テーブル）。`mise run start` を引数なしで実行すると開く |
| `internal/frontend/src/hosted` | hosted ビルドだけが使う部分（組み込み先の API、WASM を動かす Worker、ブランチの切り替えと PR の作成）。ローカルのビルドには入らない |

画面の部品は shadcn/ui で、テーマ（色・角丸・ダーク）は shadcn/ui の neutral に、図で使う色（`src/colors.css`）を足したものを `internal/frontend/src/index.css` に置いている。部品は `src/components/ui/` に置く。className を付けられない React Flow の DOM だけを `src/overrides.css` で上書きする。

`internal/static/dist` はコミットしない。`go build` の前に `go generate ./internal/static`（画面のビルド）が要る。

## 開発

ツールの版は `mise.toml` にある。

```bash
mise run start                         # ビルドして起動。パスを渡さなければサンプルの EC サイト（examples/ec）を開く
mise run start -- path/to/db/schema    # 読むファイルかディレクトリを渡す
mise run test                          # go vet・go test・Biome

# 画面だけ直すとき: Go のサーバーを起動したまま Vite の開発サーバーを使う
mise run start -- -no-open path/to/db/schema    # 別のターミナルで
cd internal/frontend && pnpm dev                 # /_/ は 127.0.0.1:6280 へ流れる
```

hosted ビルドの画面を直すときは、組み込み先のアプリを起動し、`mise run build-hosted` で `public-hosted` に WASM を置いてから、`pnpm dev --mode hosted` で `http://localhost:5173/?api=/schemap/api` を開く（`/schemap/api` は `SCHEMAP_HOST`、既定は `http://localhost:3000` へ流れる）。

## リリース

`main` に入ると `.github/workflows/release.yml` が 5 プラットフォーム（darwin/arm64・darwin/amd64・linux/amd64・linux/arm64・windows/amd64）向けにビルドし、タグ `vYYYYMMDD-N` で GitHub Release を作る。同じタグと `latest` で、`Dockerfile` から作ったコンテナイメージを `ghcr.io/varu3/schemap` に置く。最新版は次の URL で落とせる。

```
https://github.com/varu3/schemap/releases/latest/download/schemap_darwin_arm64.tar.gz
```
