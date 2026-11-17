// HCL の解析と編集をする WASM（cmd/wasm）を、画面を止めないように Web Worker で動かす。
// wasm_exec.js は Go の配布物で、WASM を作った Go と同じ版のものを使う（ビルドのときに並べて置く）。

type Go = { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
type Engine = { parse(req: string): string; edit(req: string): string };

declare const self: {
  Go: new () => Go;
  schemapEngine?: Engine;
  importScripts(url: string): void;
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

export type EngineRequest = { id: number; method: 'parse' | 'edit'; payload: string };
export type EngineInit = { init: { wasmExecUrl: string; wasmUrl: string } };
export type EngineResponse = { id: number; result?: string; error?: string };

let ready: Promise<Engine> | undefined;

async function load(wasmExecUrl: string, wasmUrl: string): Promise<Engine> {
  self.importScripts(wasmExecUrl);
  const go = new self.Go();
  const res = await fetch(wasmUrl);
  if (!res.ok) {
    throw new Error(`schemap.wasm を読めません（HTTP ${res.status}）`);
  }
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject);
  // main は終わらない（呼び出しを待ち続ける）ので、待たない
  void go.run(instance);
  if (!self.schemapEngine) {
    throw new Error('schemap.wasm を起動できません');
  }
  return self.schemapEngine;
}

self.onmessage = (e: MessageEvent<EngineRequest | EngineInit>) => {
  const msg = e.data;
  if ('init' in msg) {
    ready = load(msg.init.wasmExecUrl, msg.init.wasmUrl);
    // 読み込みの失敗は、次の呼び出しで返す
    ready.catch(() => undefined);
    return;
  }
  const reply = (r: Omit<EngineResponse, 'id'>) => self.postMessage({ id: msg.id, ...r });
  if (!ready) {
    reply({ error: 'engine is not initialized' });
    return;
  }
  ready
    .then((engine) => reply({ result: engine[msg.method](msg.payload) }))
    .catch((err: unknown) => reply({ error: err instanceof Error ? err.message : String(err) }));
};
