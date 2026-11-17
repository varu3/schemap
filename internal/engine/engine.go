// Package engine は、ファイルの中身からスキーマを解析し、画面の操作を HCL に当てる。
// ファイルの読み書きはしない。ローカルのサーバー（internal/server）と、ブラウザで動く WASM（cmd/wasm）の両方が使う。
package engine

import (
	"errors"
	"fmt"
	"slices"

	"github.com/varu3/schemap/internal/edit"
	"github.com/varu3/schemap/internal/schema"
)

// ErrBadRequest は、渡された内容が正しくない（知らないファイル、当てられない操作など）ことを表す。
var ErrBadRequest = errors.New("bad request")

func badRequest(msg string) error {
	return fmt.Errorf("%w: %s", ErrBadRequest, msg)
}

// Message は ErrBadRequest の中身（画面に出す理由）を取り出す。
func Message(err error) string {
	const prefix = "bad request: "
	if s := err.Error(); len(s) > len(prefix) && s[:len(prefix)] == prefix {
		return s[len(prefix):]
	}
	return err.Error()
}

// Parse は files を解析する。overrides（パス → 編集中の中身）があれば、そのファイルを差し替えてから解析する。
// 構文エラーは *schema.ParseError で返す。
func Parse(files []schema.File, overrides map[string]string) (*schema.Schema, error) {
	files = slices.Clone(files)
	known := map[string]bool{}
	for i, f := range files {
		known[f.Path] = true
		if edited, ok := overrides[f.Path]; ok {
			files[i].Src = []byte(edited)
		}
	}
	for path := range overrides {
		if !known[path] {
			return nil, badRequest("unknown file: " + path)
		}
	}
	return schema.Parse(files)
}

type EditResult struct {
	// Sources は操作で変わったファイルの中身。テーブルを消すと、参照していたほかのファイルも変わる
	Sources map[string]string `json:"sources"`
	Schema  *schema.Schema    `json:"schema"`
}

// Edit は ops を順に path のファイルに当て、当てたあとの中身と解析したスキーマを返す。
// 操作は overrides の中身（無ければ files の中身）に当てる。途中の操作が当てられなければ、全体を当てない。
func Edit(files []schema.File, path string, overrides map[string]string, ops []edit.Op) (*EditResult, error) {
	files = slices.Clone(files)
	target := -1
	for i, f := range files {
		if src, ok := overrides[f.Path]; ok {
			files[i].Src = []byte(src)
		}
		if f.Path == path {
			target = i
		}
	}
	if target < 0 {
		return nil, badRequest("unknown file: " + path)
	}
	// 操作の前のスキーマ。ファイルをまたいだ確認（同じ名前のテーブル、FK の参照先）に使う。操作を当てるたびに解析し直す
	current, err := schema.Parse(files)
	if err != nil {
		return nil, err
	}
	changed := map[string]bool{path: true}
	for _, op := range ops {
		if err := checkAcrossFiles(current, op); err != nil {
			return nil, badRequest(err.Error())
		}
		// テーブルを消すときは、ほかのファイルからの FK も消すので、すべてのファイルに当てる
		apply := []int{target}
		if op.Kind == "deleteTable" {
			apply = apply[:0]
			for i := range files {
				apply = append(apply, i)
			}
		}
		for _, i := range apply {
			out, err := edit.Apply(files[i].Src, op)
			if errors.Is(err, edit.ErrInvalid) {
				return nil, badRequest(err.Error())
			}
			if err != nil {
				return nil, err
			}
			if string(out) != string(files[i].Src) {
				changed[files[i].Path] = true
			}
			files[i].Src = out
		}
		current, err = schema.Parse(files)
		if err != nil {
			return nil, err
		}
	}
	sources := map[string]string{}
	for _, f := range files {
		if changed[f.Path] {
			sources[f.Path] = string(f.Src)
		}
	}
	return &EditResult{Sources: sources, Schema: current}, nil
}

// checkAcrossFiles は、1 つのファイルの中だけでは分からない確認をする
func checkAcrossFiles(s *schema.Schema, op edit.Op) error {
	switch op.Kind {
	case "addTable":
		if s.Table(op.Table) != nil {
			return fmt.Errorf("table %q already exists", op.Table)
		}
	case "deleteTable":
		if s.Table(op.Table) == nil {
			return fmt.Errorf("table %q not found", op.Table)
		}
	case "addForeignKey":
		ref := s.Table(op.RefTable)
		if ref == nil {
			return fmt.Errorf("ref table %q not found", op.RefTable)
		}
		for _, c := range op.RefColumns {
			if !slices.ContainsFunc(ref.Columns, func(col *schema.Column) bool { return col.Name == c }) {
				return fmt.Errorf("column %q not found in %s", c, op.RefTable)
			}
		}
	}
	return nil
}
