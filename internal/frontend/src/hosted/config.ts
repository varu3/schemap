// hosted ビルド（pnpm build:hosted）は、ほかのアプリの画面に組み込んで使う形。
// ファイルは組み込み先の API から読み、HCL の解析と編集はブラウザの WASM で行い、保存の代わりに PR を作る。
// ローカルのビルドでは HOSTED が false に決まるので、このディレクトリの中身はバンドルに入らない。
export const HOSTED = import.meta.env.MODE === 'hosted';

const params = new URLSearchParams(window.location.search);

// 組み込み先の API の場所。同じオリジンのパスだけを受け付ける（ほかのオリジンへ中身を送らないため）
function apiBase(): string {
  const v = params.get('api') ?? '';
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) {
    throw new Error('api には同じオリジンのパスを指定してください');
  }
  return v.replace(/\/+$/, '');
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

// 読み込むブランチ。空なら組み込み先の既定
export function currentRef(): string {
  return params.get('ref') ?? '';
}

// 表示の設定を URL に書き直すときに、組み込み先が渡したパラメータを残す
export function keepHostedParams(q: URLSearchParams): void {
  if (!HOSTED) {
    return;
  }
  for (const key of ['api', 'ref']) {
    const v = params.get(key);
    if (v !== null) {
      q.set(key, v);
    }
  }
}

// ブランチを切り替える。編集中の中身も図の位置も捨てて読み直す
export function switchRef(ref: string): void {
  const q = new URLSearchParams(window.location.search);
  q.set('ref', ref);
  window.location.search = q.toString();
}

export type HostedRef = { name: string; editable: boolean };

export type HostedGithub = {
  // true なら、PR を作る前に本人の GitHub アカウントとの連携が要る
  required: boolean;
  linked: boolean;
  login?: string;
};

export type HostedMeta = {
  ref: string;
  // 読み込んだコミット。PR はこのコミットから切る
  sha: string;
  // false のブランチは読むだけ（編集も PR もできない）
  editable: boolean;
  refs: HostedRef[];
  // PR を出す先のリポジトリ（owner/name）
  repository: string;
  github: HostedGithub;
};

let meta: HostedMeta | undefined;

export function setHostedMeta(m: HostedMeta): void {
  meta = m;
}

// 読み込みが終わるまでは undefined
export function hostedMeta(): HostedMeta | undefined {
  return meta;
}
