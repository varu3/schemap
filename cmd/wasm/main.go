//go:build js && wasm

// wasm は、HCL の解析と編集（internal/engine）をブラウザで動かす。
// サーバーにファイルを置かずに使う形（ほかのアプリに組み込む hosted ビルド）で、画面の Web Worker が読み込む。
//
// globalThis.schemapEngine に parse / edit を置く。どちらも JSON の文字列を受け取り、
// {"status": <HTTP のステータスに当たる数>, "body": <ローカルのサーバーが返すのと同じ JSON>} の文字列を返す。
package main

import (
	"encoding/json"
	"errors"
	"syscall/js"

	"github.com/varu3/schemap/internal/edit"
	"github.com/varu3/schemap/internal/engine"
	"github.com/varu3/schemap/internal/schema"
)

type file struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

type request struct {
	// Files は読み込んだときの中身（ローカルのサーバーではディスクの中身に当たる）
	Files     []file            `json:"files"`
	Overrides map[string]string `json:"overrides"`
	// Path と Ops は edit だけが使う
	Path string    `json:"path"`
	Ops  []edit.Op `json:"ops"`
}

type response struct {
	Status int `json:"status"`
	Body   any `json:"body"`
}

func main() {
	js.Global().Set("schemapEngine", map[string]any{
		"parse": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return handle(args, func(req request) (any, error) {
				return engine.Parse(files(req), req.Overrides)
			})
		}),
		"edit": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return handle(args, func(req request) (any, error) {
				return engine.Edit(files(req), req.Path, req.Overrides, req.Ops)
			})
		}),
	})
	select {}
}

func files(req request) []schema.File {
	out := make([]schema.File, len(req.Files))
	for i, f := range req.Files {
		out[i] = schema.File{Path: f.Path, Src: []byte(f.Source)}
	}
	return out
}

func handle(args []js.Value, fn func(request) (any, error)) string {
	var req request
	if len(args) != 1 || json.Unmarshal([]byte(args[0].String()), &req) != nil {
		return encode(response{Status: 400, Body: map[string]string{"error": "invalid request body"}})
	}
	body, err := fn(req)
	var pe *schema.ParseError
	switch {
	case errors.As(err, &pe):
		return encode(response{Status: 422, Body: map[string]any{"error": pe.Error(), "parseError": pe}})
	case errors.Is(err, engine.ErrBadRequest):
		return encode(response{Status: 400, Body: map[string]string{"error": engine.Message(err)}})
	case err != nil:
		return encode(response{Status: 500, Body: map[string]string{"error": err.Error()}})
	}
	return encode(response{Status: 200, Body: body})
}

func encode(r response) string {
	b, err := json.Marshal(r)
	if err != nil {
		return `{"status":500,"body":{"error":"encode response"}}`
	}
	return string(b)
}
