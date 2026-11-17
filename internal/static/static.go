// Package static は internal/frontend のビルド結果をバイナリに取り込む。
// dist はコミットしないため、go build の前に go generate が要る（mise run build がまとめて行う）。
package static

import "embed"

//go:generate sh -c "cd ../frontend && pnpm install --frozen-lockfile && pnpm run build"

//go:embed all:dist
var Frontend embed.FS
