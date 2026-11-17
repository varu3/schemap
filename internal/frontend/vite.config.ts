import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// --mode hosted は、ほかのアプリの画面に組み込む形（src/hosted）。ビルド結果は dist-hosted に出し、
// Go のバイナリには取り込まない。public-hosted には schemap.wasm と wasm_exec.js を置く（mise run build-hosted が作る）
export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted';
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // ローカルのビルドには Worker を取り込まない（Vite は、使われないコードの中の new Worker も出力するため）
        ...(hosted
          ? []
          : [{ find: '@/hosted/engine', replacement: path.resolve(__dirname, './src/hosted/engine.stub.ts') }]),
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
    // 組み込み先がどのパスで配ってもよいように、アセットは index.html からの相対パスで読む
    base: hosted ? './' : '/',
    publicDir: hosted ? 'public-hosted' : 'public',
    build: {
      outDir: hosted ? 'dist-hosted' : '../static/dist',
      emptyOutDir: true,
      // ローカルで配るだけなので、1 ファイルにまとまっていてよい
      chunkSizeWarningLimit: 1000,
    },
    server: {
      // pnpm dev のときは API を Go のサーバー（schemap -no-open）へ流す。
      // hosted のときは、組み込み先（SCHEMAP_HOST。既定は http://localhost:3000）へ流す
      proxy: hosted
        ? { '/schemap/api': process.env.SCHEMAP_HOST ?? 'http://localhost:3000' }
        : { '/_/': 'http://127.0.0.1:6280' },
    },
  };
});
