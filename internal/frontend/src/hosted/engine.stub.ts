import type { EngineResult } from './engine';

// ローカルのビルドで engine.ts の代わりに読み込む。hosted ビルドでしか呼ばれない
export function callEngine(): Promise<EngineResult> {
  return Promise.reject(new Error('hosted ビルドでだけ使えます'));
}
