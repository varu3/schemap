import type { EngineInit, EngineRequest, EngineResponse } from './engine.worker';

// ローカルのサーバーの応答に当たるもの（status は HTTP のステータスと同じ意味）
export type EngineResult = { status: number; body: unknown };

let worker: Worker | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (v: EngineResult) => void; reject: (e: Error) => void }>();

function start(): Worker {
  const w = new Worker(new URL('./engine.worker.ts', import.meta.url));
  w.onmessage = (e: MessageEvent<EngineResponse>) => {
    const p = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (!p) {
      return;
    }
    if (e.data.result === undefined) {
      p.reject(new Error(e.data.error ?? 'engine error'));
      return;
    }
    p.resolve(JSON.parse(e.data.result) as EngineResult);
  };
  // schemap.wasm と wasm_exec.js は index.html と同じ場所に置く
  const init: EngineInit = {
    init: {
      wasmExecUrl: new URL('wasm_exec.js', document.baseURI).href,
      wasmUrl: new URL('schemap.wasm', document.baseURI).href,
    },
  };
  w.postMessage(init);
  return w;
}

export function callEngine(method: EngineRequest['method'], payload: unknown): Promise<EngineResult> {
  worker ??= start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const req: EngineRequest = { id, method, payload: JSON.stringify(payload) };
    worker?.postMessage(req);
  });
}
