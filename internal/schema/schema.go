// Package schema は db/schema の Atlas HCL を読み、ER 図に必要な構造だけを取り出す。
//
// 式は評価せず、書かれた文字列のまま持つ（type = varchar(255)、default = sql("now()") など）。
// 各ブロックはファイル内のバイト範囲を持ち、編集時はその範囲だけを差し替える。
package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

// File は解析対象の 1 ファイル。Path は db/schema からの相対パス。
type File struct {
	Path string
	Src  []byte
}

// Range はブロックのファイル内の位置。Start と End はバイトオフセット。
type Range struct {
	File  string `json:"file"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Line  int    `json:"line"`
	// EndLine はブロックの最終行（} の行）
	EndLine int `json:"endLine"`
}

type Schema struct {
	Tables []*Table `json:"tables"`
	Enums  []*Enum  `json:"enums"`
	// Files は解析したファイルの中身。画面のエディタはファイル全体を出す
	Files []SourceFile `json:"files"`
}

type SourceFile struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	// Hash は Source の SHA-256。保存のとき、読み込んでからディスクのファイルが変わっていないかを確かめるのに使う
	Hash string `json:"hash"`
}

// Hash は保存の競合を見分けるためのハッシュ（SHA-256 の 16 進）。
func Hash(src []byte) string {
	sum := sha256.Sum256(src)
	return hex.EncodeToString(sum[:])
}

type Table struct {
	Name        string        `json:"name"`
	Schema      string        `json:"schema"`
	Comment     string        `json:"comment,omitempty"`
	Range       Range         `json:"range"`
	Columns     []*Column     `json:"columns"`
	PrimaryKey  []string      `json:"primaryKey"`
	ForeignKeys []*ForeignKey `json:"foreignKeys"`
	Indexes     []*Index      `json:"indexes"`
	Uniques     []*Index      `json:"uniques"`
	Checks      []*Check      `json:"checks"`
}

type Column struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Null    bool   `json:"null"`
	Default string `json:"default,omitempty"`
	Comment string `json:"comment,omitempty"`
	Range   Range  `json:"range"`
}

type ForeignKey struct {
	Name       string   `json:"name"`
	Columns    []string `json:"columns"`
	RefTable   string   `json:"refTable"`
	RefColumns []string `json:"refColumns"`
	OnUpdate   string   `json:"onUpdate,omitempty"`
	OnDelete   string   `json:"onDelete,omitempty"`
	Range      Range    `json:"range"`
}

// Index は index ブロックと unique ブロックの両方を表す。
// on { column = ... } や on { expr = ... } の形は Columns に列名か式の文字列で入る。
type Index struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique,omitempty"`
	Type    string   `json:"type,omitempty"`
	Where   string   `json:"where,omitempty"`
	Range   Range    `json:"range"`
}

type Check struct {
	Name  string `json:"name"`
	Expr  string `json:"expr"`
	Range Range  `json:"range"`
}

type Enum struct {
	Name   string   `json:"name"`
	Schema string   `json:"schema"`
	Values []string `json:"values"`
	Range  Range    `json:"range"`
}

// Table は名前でテーブルを探す。スキーマをまたいで同名のテーブルは無い前提。
func (s *Schema) Table(name string) *Table {
	for _, t := range s.Tables {
		if t.Name == name {
			return t
		}
	}
	return nil
}

// Parse は複数ファイルを 1 つのスキーマとして読む。
// あるファイルからほかのファイルのテーブルを参照するため、ファイルをまたいで 1 つにまとめる。
func Parse(files []File) (*Schema, error) {
	s := &Schema{Tables: []*Table{}, Enums: []*Enum{}, Files: []SourceFile{}}
	for _, f := range files {
		s.Files = append(s.Files, SourceFile{Path: f.Path, Source: string(f.Src), Hash: Hash(f.Src)})
		hf, diags := hclsyntax.ParseConfig(f.Src, f.Path, hcl.InitialPos)
		if diags.HasErrors() {
			return nil, newParseError(f.Path, diags)
		}
		p := parser{file: f}
		for _, b := range hf.Body.(*hclsyntax.Body).Blocks {
			switch b.Type {
			case "table":
				t, err := p.table(b)
				if err != nil {
					return nil, err
				}
				s.Tables = append(s.Tables, t)
			case "enum":
				s.Enums = append(s.Enums, p.enum(b))
			}
		}
	}
	sort.SliceStable(s.Tables, func(i, j int) bool { return s.Tables[i].Name < s.Tables[j].Name })
	sort.SliceStable(s.Enums, func(i, j int) bool { return s.Enums[i].Name < s.Enums[j].Name })
	return s, nil
}

// ParseError は HCL の構文エラー。画面のエディタでエラーの行を示すために位置を持つ
type ParseError struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Message string `json:"message"`
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("%s:%d: %s", e.File, e.Line, e.Message)
}

func newParseError(file string, diags hcl.Diagnostics) *ParseError {
	e := &ParseError{File: file, Message: diags.Error()}
	for _, d := range diags {
		if d.Severity != hcl.DiagError {
			continue
		}
		e.Message = d.Summary
		if d.Detail != "" {
			e.Message += ": " + d.Detail
		}
		if d.Subject != nil {
			e.Line = d.Subject.Start.Line
		}
		break
	}
	return e
}

type parser struct {
	file File
}

func (p parser) rangeOf(b *hclsyntax.Block) Range {
	r := b.Range()
	return Range{File: p.file.Path, Start: r.Start.Byte, End: r.End.Byte, Line: r.Start.Line, EndLine: r.End.Line}
}

// raw は式を評価せず、ソースに書かれたとおりの文字列で返す。
func (p parser) raw(body *hclsyntax.Body, name string) string {
	a, ok := body.Attributes[name]
	if !ok {
		return ""
	}
	return strings.TrimSpace(string(a.Expr.Range().SliceBytes(p.file.Src)))
}

// last は column.id や table.shops.column.id のような参照の末尾の名前を返す。
// RESTRICT や CASCADE のような裸の識別子もこれで読む。
func (p parser) last(body *hclsyntax.Body, name string) string {
	a, ok := body.Attributes[name]
	if !ok {
		return ""
	}
	names := traversalNames(a.Expr)
	if len(names) == 0 {
		return p.raw(body, name)
	}
	return names[len(names)-1]
}

// str は文字列の属性（comment など）を、エスケープを解いた値で返す。式なら書かれたとおりに返す
func (p parser) str(body *hclsyntax.Body, name string) string {
	a, ok := body.Attributes[name]
	if !ok {
		return ""
	}
	if v, diags := a.Expr.Value(nil); !diags.HasErrors() && v.Type() == cty.String && v.IsKnown() && !v.IsNull() {
		return v.AsString()
	}
	return p.raw(body, name)
}

func (p parser) boolAttr(body *hclsyntax.Body, name string) bool {
	return p.raw(body, name) == "true"
}

// list は [column.a, column.b] の各要素を traversal の名前列として返す。
func (p parser) list(body *hclsyntax.Body, name string) [][]string {
	a, ok := body.Attributes[name]
	if !ok {
		return nil
	}
	tup, ok := a.Expr.(*hclsyntax.TupleConsExpr)
	if !ok {
		return nil
	}
	out := make([][]string, 0, len(tup.Exprs))
	for _, e := range tup.Exprs {
		if names := traversalNames(e); len(names) > 0 {
			out = append(out, names)
			continue
		}
		out = append(out, []string{strings.TrimSpace(string(e.Range().SliceBytes(p.file.Src)))})
	}
	return out
}

func (p parser) lastOfList(body *hclsyntax.Body, name string) []string {
	items := p.list(body, name)
	out := make([]string, 0, len(items))
	for _, names := range items {
		out = append(out, names[len(names)-1])
	}
	return out
}

func traversalNames(e hclsyntax.Expression) []string {
	st, ok := e.(*hclsyntax.ScopeTraversalExpr)
	if !ok {
		return nil
	}
	names := []string{}
	for _, step := range st.Traversal {
		switch s := step.(type) {
		case hcl.TraverseRoot:
			names = append(names, s.Name)
		case hcl.TraverseAttr:
			names = append(names, s.Name)
		}
	}
	return names
}

func label(b *hclsyntax.Block) string {
	if len(b.Labels) == 0 {
		return ""
	}
	return b.Labels[len(b.Labels)-1]
}

func (p parser) table(b *hclsyntax.Block) (*Table, error) {
	t := &Table{
		Name:        label(b),
		Schema:      p.last(b.Body, "schema"),
		Comment:     p.str(b.Body, "comment"),
		Range:       p.rangeOf(b),
		Columns:     []*Column{},
		PrimaryKey:  []string{},
		ForeignKeys: []*ForeignKey{},
		Indexes:     []*Index{},
		Uniques:     []*Index{},
		Checks:      []*Check{},
	}
	for _, c := range b.Body.Blocks {
		switch c.Type {
		case "column":
			t.Columns = append(t.Columns, &Column{
				Name:    label(c),
				Type:    p.raw(c.Body, "type"),
				Null:    p.boolAttr(c.Body, "null"),
				Default: p.raw(c.Body, "default"),
				Comment: p.str(c.Body, "comment"),
				Range:   p.rangeOf(c),
			})
		case "primary_key":
			t.PrimaryKey = p.lastOfList(c.Body, "columns")
		case "foreign_key":
			fk, err := p.foreignKey(c)
			if err != nil {
				return nil, fmt.Errorf("table %s: %w", t.Name, err)
			}
			t.ForeignKeys = append(t.ForeignKeys, fk)
		case "index":
			t.Indexes = append(t.Indexes, p.index(c))
		case "unique":
			u := p.index(c)
			u.Unique = true
			t.Uniques = append(t.Uniques, u)
		case "check":
			t.Checks = append(t.Checks, &Check{Name: label(c), Expr: p.raw(c.Body, "expr"), Range: p.rangeOf(c)})
		}
	}
	return t, nil
}

func (p parser) foreignKey(b *hclsyntax.Block) (*ForeignKey, error) {
	fk := &ForeignKey{
		Name:       label(b),
		Columns:    p.lastOfList(b.Body, "columns"),
		RefColumns: []string{},
		OnUpdate:   p.last(b.Body, "on_update"),
		OnDelete:   p.last(b.Body, "on_delete"),
		Range:      p.rangeOf(b),
	}
	// ref_columns は table.<name>.column.<col> の形。参照先テーブルはここから取る。
	for _, names := range p.list(b.Body, "ref_columns") {
		if len(names) < 4 || names[0] != "table" {
			return nil, fmt.Errorf("foreign_key %s: unsupported ref_columns %v", fk.Name, names)
		}
		fk.RefTable = names[len(names)-3]
		fk.RefColumns = append(fk.RefColumns, names[len(names)-1])
	}
	return fk, nil
}

func (p parser) index(b *hclsyntax.Block) *Index {
	idx := &Index{
		Name:    label(b),
		Columns: p.lastOfList(b.Body, "columns"),
		Unique:  p.boolAttr(b.Body, "unique"),
		Type:    p.raw(b.Body, "type"),
		Where:   strings.Trim(p.raw(b.Body, "where"), `"`),
		Range:   p.rangeOf(b),
	}
	for _, on := range b.Body.Blocks {
		if on.Type != "on" {
			continue
		}
		if col := p.last(on.Body, "column"); col != "" {
			idx.Columns = append(idx.Columns, col)
			continue
		}
		idx.Columns = append(idx.Columns, p.raw(on.Body, "expr"))
	}
	return idx
}

func (p parser) enum(b *hclsyntax.Block) *Enum {
	e := &Enum{Name: label(b), Schema: p.last(b.Body, "schema"), Values: []string{}, Range: p.rangeOf(b)}
	for _, v := range p.list(b.Body, "values") {
		e.Values = append(e.Values, strings.Trim(v[0], `"`))
	}
	return e
}
