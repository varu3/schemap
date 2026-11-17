// Package edit は、画面の操作（テーブル・列・FK の追加と削除、コメントの変更）を HCL のテキストへの差し込みとして行う。
//
// ファイル全体を整形し直さず、hclsyntax で取ったブロックのバイト位置に新しい行を差し込む（または属性の式だけを
// 差し替える）。そのため、操作した場所以外のバイトは変わらない。改行は LF を前提とする。
package edit

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

// ErrInvalid は、操作の内容が正しくない（名前の形が違う、同じ名前がある、対象が無いなど）ことを表す。
var ErrInvalid = errors.New("invalid edit")

type Op struct {
	// Kind は addTable / addColumn / addForeignKey / setComment / deleteTable / deleteForeignKey
	Kind string `json:"kind"`
	// Table は対象のテーブル（addTable では新しいテーブルの名前）
	Table string `json:"table"`
	// Column は setComment で列のコメントを変えるときの列。空ならテーブルのコメント
	Column string `json:"column,omitempty"`

	// addTable
	Schema string `json:"schema,omitempty"`

	// addColumn（addTable では主キーの列。空なら id serial）
	Name    string `json:"name,omitempty"`
	Type    string `json:"type,omitempty"`
	Null    bool   `json:"null,omitempty"`
	Default string `json:"default,omitempty"`

	// addForeignKey（Name を空にすると <table>_<column>_fkey にする）。deleteForeignKey は Name の FK を消す
	Columns    []string `json:"columns,omitempty"`
	RefTable   string   `json:"refTable,omitempty"`
	RefColumns []string `json:"refColumns,omitempty"`
	OnUpdate   string   `json:"onUpdate,omitempty"`
	OnDelete   string   `json:"onDelete,omitempty"`

	// addTable / addColumn / setComment
	Comment string `json:"comment,omitempty"`
}

var ident = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var refActions = map[string]bool{"RESTRICT": true, "CASCADE": true, "NO_ACTION": true, "SET_NULL": true, "SET_DEFAULT": true}

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// Apply は op を src に当てた結果を返す。
func Apply(src []byte, op Op) ([]byte, error) {
	f, diags := hclsyntax.ParseConfig(src, "", hcl.InitialPos)
	if diags.HasErrors() {
		return nil, fmt.Errorf("parse: %s", diags.Error())
	}
	body := f.Body.(*hclsyntax.Body)
	switch op.Kind {
	case "addTable":
		return addTable(src, body, op)
	case "addColumn":
		return addColumn(src, body, op)
	case "addForeignKey":
		return addForeignKey(src, body, op)
	case "setComment":
		return setComment(src, body, op)
	case "deleteTable":
		return deleteTable(src, body, op)
	case "deleteForeignKey":
		return deleteForeignKey(src, body, op)
	default:
		return nil, invalid("unknown kind %q", op.Kind)
	}
}

func addTable(src []byte, body *hclsyntax.Body, op Op) ([]byte, error) {
	if !ident.MatchString(op.Table) {
		return nil, invalid("table name %q", op.Table)
	}
	if !ident.MatchString(op.Schema) {
		return nil, invalid("schema name %q", op.Schema)
	}
	if findBlock(body, "table", op.Table) != nil {
		return nil, invalid("table %q already exists", op.Table)
	}
	// テーブルはそのファイルで宣言しているスキーマにだけ足せる（Atlas が後で拒むため）
	if findBlock(body, "schema", op.Schema) == nil {
		return nil, invalid("schema %q is not declared in this file", op.Schema)
	}
	pk, pkType := op.Name, op.Type
	if pk == "" {
		pk = "id"
	}
	if pkType == "" {
		pkType = "serial"
	}
	if !ident.MatchString(pk) {
		return nil, invalid("column name %q", pk)
	}
	if err := checkExpr("type", pkType); err != nil {
		return nil, err
	}
	unit := indentUnit(src, body)
	attrs := [][2]string{{"schema", "schema." + op.Schema}}
	if op.Comment != "" {
		attrs = append(attrs, [2]string{"comment", quote(op.Comment)})
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\ntable %s {\n", quote(op.Table))
	writeAttrs(&b, unit, attrs)
	fmt.Fprintf(&b, "%scolumn %s {\n", unit, quote(pk))
	writeAttrs(&b, unit+unit, [][2]string{{"null", "false"}, {"type", pkType}})
	fmt.Fprintf(&b, "%s}\n", unit)
	fmt.Fprintf(&b, "%sprimary_key {\n", unit)
	writeAttrs(&b, unit+unit, [][2]string{{"columns", "[column." + pk + "]"}})
	fmt.Fprintf(&b, "%s}\n}\n", unit)

	// ファイルの末尾には enum や trigger が並ぶので、最後の table の後ろに入れる
	last := lastBlock(body.Blocks, "table")
	if last == nil {
		last = lastBlock(body.Blocks, "schema")
	}
	at := len(src)
	if last != nil {
		at = lineEndAfter(src, last.Range().End.Byte)
	}
	return insert(src, at, b.String()), nil
}

func addColumn(src []byte, body *hclsyntax.Body, op Op) ([]byte, error) {
	table, err := tableBlock(body, op.Table)
	if err != nil {
		return nil, err
	}
	if !ident.MatchString(op.Name) {
		return nil, invalid("column name %q", op.Name)
	}
	if findBlock(table.Body, "column", op.Name) != nil {
		return nil, invalid("column %q already exists in %s", op.Name, op.Table)
	}
	if err := checkExpr("type", op.Type); err != nil {
		return nil, err
	}
	if op.Default != "" {
		if err := checkExpr("default", op.Default); err != nil {
			return nil, err
		}
	}
	attrs := [][2]string{{"null", fmt.Sprint(op.Null)}, {"type", op.Type}}
	if op.Default != "" {
		attrs = append(attrs, [2]string{"default", op.Default})
	}
	if op.Comment != "" {
		attrs = append(attrs, [2]string{"comment", quote(op.Comment)})
	}
	at, indent := childInsertPoint(src, body, table, lastBlock(table.Body.Blocks, "column"))
	var b strings.Builder
	fmt.Fprintf(&b, "%scolumn %s {\n", indent, quote(op.Name))
	writeAttrs(&b, indent+indentUnit(src, body), attrs)
	fmt.Fprintf(&b, "%s}\n", indent)
	return insert(src, at, b.String()), nil
}

func addForeignKey(src []byte, body *hclsyntax.Body, op Op) ([]byte, error) {
	table, err := tableBlock(body, op.Table)
	if err != nil {
		return nil, err
	}
	if len(op.Columns) == 0 || len(op.Columns) != len(op.RefColumns) {
		return nil, invalid("columns and refColumns must have the same length")
	}
	if !ident.MatchString(op.RefTable) {
		return nil, invalid("ref table %q", op.RefTable)
	}
	for _, c := range op.Columns {
		if findBlock(table.Body, "column", c) == nil {
			return nil, invalid("column %q not found in %s", c, op.Table)
		}
	}
	for _, c := range op.RefColumns {
		if !ident.MatchString(c) {
			return nil, invalid("ref column %q", c)
		}
	}
	name := op.Name
	if name == "" {
		// 既存の名前（<table>_<column>_fkey）に合わせる。重なれば _2, _3 … を付ける
		base := op.Table + "_" + op.Columns[0] + "_fkey"
		name = base
		for i := 2; findBlock(table.Body, "foreign_key", name) != nil; i++ {
			name = fmt.Sprintf("%s_%d", base, i)
		}
	}
	if !ident.MatchString(name) {
		return nil, invalid("foreign key name %q", name)
	}
	if findBlock(table.Body, "foreign_key", name) != nil {
		return nil, invalid("foreign key %q already exists in %s", name, op.Table)
	}
	onUpdate, onDelete := op.OnUpdate, op.OnDelete
	if onUpdate == "" {
		onUpdate = "RESTRICT"
	}
	if onDelete == "" {
		onDelete = "RESTRICT"
	}
	if !refActions[onUpdate] || !refActions[onDelete] {
		return nil, invalid("on_update / on_delete must be one of RESTRICT, CASCADE, NO_ACTION, SET_NULL, SET_DEFAULT")
	}
	cols := make([]string, len(op.Columns))
	refs := make([]string, len(op.RefColumns))
	for i := range op.Columns {
		cols[i] = "column." + op.Columns[i]
		refs[i] = "table." + op.RefTable + ".column." + op.RefColumns[i]
	}
	// 最後の FK の後ろ、無ければ主キーの後ろ、それも無ければ最後の列の後ろに入れる
	after := lastBlock(table.Body.Blocks, "foreign_key")
	if after == nil {
		after = lastBlock(table.Body.Blocks, "primary_key")
	}
	if after == nil {
		after = lastBlock(table.Body.Blocks, "column")
	}
	at, indent := childInsertPoint(src, body, table, after)
	var b strings.Builder
	fmt.Fprintf(&b, "%sforeign_key %s {\n", indent, quote(name))
	writeAttrs(&b, indent+indentUnit(src, body), [][2]string{
		{"columns", "[" + strings.Join(cols, ", ") + "]"},
		{"ref_columns", "[" + strings.Join(refs, ", ") + "]"},
		{"on_update", onUpdate},
		{"on_delete", onDelete},
	})
	fmt.Fprintf(&b, "%s}\n", indent)
	return insert(src, at, b.String()), nil
}

func setComment(src []byte, body *hclsyntax.Body, op Op) ([]byte, error) {
	table, err := tableBlock(body, op.Table)
	if err != nil {
		return nil, err
	}
	target := table
	if op.Column != "" {
		target = findBlock(table.Body, "column", op.Column)
		if target == nil {
			return nil, invalid("column %q not found in %s", op.Column, op.Table)
		}
	}
	if a, ok := target.Body.Attributes["comment"]; ok {
		if op.Comment == "" {
			// 空にしたら、属性の行ごと消す
			from := lineStart(src, a.SrcRange.Start.Byte)
			to := lineEndAfter(src, a.SrcRange.End.Byte)
			return splice(src, from, to, ""), nil
		}
		r := a.Expr.Range()
		return splice(src, r.Start.Byte, r.End.Byte, quote(op.Comment)), nil
	}
	if op.Comment == "" {
		return src, nil
	}
	// 新しく書くときは、テーブルなら schema の次、列なら最後の属性の次に入れる
	var after *hclsyntax.Attribute
	if op.Column == "" {
		after = target.Body.Attributes["schema"]
	} else {
		for _, a := range target.Body.Attributes {
			if after == nil || a.SrcRange.End.Byte > after.SrcRange.End.Byte {
				after = a
			}
		}
	}
	var at int
	var indent string
	if after != nil {
		at = lineEndAfter(src, after.SrcRange.End.Byte)
		indent = strings.Repeat(" ", after.SrcRange.Start.Column-1)
	} else {
		at = lineEndAfter(src, target.OpenBraceRange.End.Byte)
		indent = strings.Repeat(" ", target.Range().Start.Column-1) + indentUnit(src, body)
	}
	return insert(src, at, indent+"comment = "+quote(op.Comment)+"\n"), nil
}

// deleteTable はテーブルと、それにつながるもの（ほかのテーブルからそのテーブルへの FK、そのテーブルの trigger）を消す。
// ファイルをまたいで参照されるので、どのファイルにも当てられる。消すものが無いファイルはそのまま返す
func deleteTable(src []byte, body *hclsyntax.Body, op Op) ([]byte, error) {
	if !ident.MatchString(op.Table) {
		return nil, invalid("table name %q", op.Table)
	}
	ref := regexp.MustCompile(`\btable\.` + regexp.QuoteMeta(op.Table) + `\.column\.`)
	var remove []hcl.Range
	for _, b := range body.Blocks {
		switch {
		case b.Type == "table" && len(b.Labels) > 0 && b.Labels[len(b.Labels)-1] == op.Table:
			remove = append(remove, b.Range())
		case b.Type == "table":
			for _, fk := range b.Body.Blocks {
				if a, ok := fk.Body.Attributes["ref_columns"]; fk.Type == "foreign_key" && ok && ref.Match(exprText(src, a)) {
					remove = append(remove, fk.Range())
				}
			}
		case b.Type == "trigger":
			if a, ok := b.Body.Attributes["on"]; ok && string(exprText(src, a)) == "table."+op.Table {
				remove = append(remove, b.Range())
			}
		}
	}
	return removeBlocks(src, remove), nil
}

func deleteForeignKey(src []byte, body *hclsyntax.Body, op Op) ([]byte, error) {
	table, err := tableBlock(body, op.Table)
	if err != nil {
		return nil, err
	}
	fk := findBlock(table.Body, "foreign_key", op.Name)
	if fk == nil {
		return nil, invalid("foreign key %q not found in %s", op.Name, op.Table)
	}
	return removeBlocks(src, []hcl.Range{fk.Range()}), nil
}

func exprText(src []byte, a *hclsyntax.Attribute) []byte {
	r := a.Expr.Range()
	return []byte(strings.TrimSpace(string(src[r.Start.Byte:r.End.Byte])))
}

// removeBlocks はブロックを、その行ごと消す（字下げと閉じ括弧の後ろの改行も）。後ろから消すので位置はずれない。
// 前後がどちらも空行なら、空行を 1 つだけ残す
func removeBlocks(src []byte, ranges []hcl.Range) []byte {
	out := src
	for i := len(ranges) - 1; i >= 0; i-- {
		from := lineStart(out, ranges[i].Start.Byte)
		to := lineEndAfter(out, ranges[i].End.Byte)
		blankBefore := from == 0 || (from >= 2 && out[from-2] == '\n')
		if blankBefore && to < len(out) && out[to] == '\n' {
			to++
		}
		out = splice(out, from, to, "")
	}
	return out
}

// childInsertPoint は block の中で after の次の行（after が無ければ { の次の行）と、そこで使う字下げを返す。
func childInsertPoint(src []byte, body *hclsyntax.Body, block, after *hclsyntax.Block) (int, string) {
	if after != nil {
		return lineEndAfter(src, after.Range().End.Byte), strings.Repeat(" ", after.Range().Start.Column-1)
	}
	indent := strings.Repeat(" ", block.Range().Start.Column-1) + indentUnit(src, body)
	return lineEndAfter(src, block.OpenBraceRange.End.Byte), indent
}

func tableBlock(body *hclsyntax.Body, name string) (*hclsyntax.Block, error) {
	b := findBlock(body, "table", name)
	if b == nil {
		return nil, invalid("table %q not found", name)
	}
	return b, nil
}

func findBlock(body *hclsyntax.Body, typ, label string) *hclsyntax.Block {
	for _, b := range body.Blocks {
		if b.Type == typ && len(b.Labels) > 0 && b.Labels[len(b.Labels)-1] == label {
			return b
		}
	}
	return nil
}

func lastBlock(blocks hclsyntax.Blocks, typ string) *hclsyntax.Block {
	var last *hclsyntax.Block
	for _, b := range blocks {
		if b.Type == typ {
			last = b
		}
	}
	return last
}

// indentUnit はファイルの字下げ 1 段分。最初に見つかった、トップレベルのブロックの中の属性かブロックから決める
func indentUnit(src []byte, body *hclsyntax.Body) string {
	for _, b := range body.Blocks {
		for _, a := range b.Body.Attributes {
			if n := a.SrcRange.Start.Column - b.Range().Start.Column; n > 0 {
				return strings.Repeat(" ", n)
			}
		}
		for _, c := range b.Body.Blocks {
			if n := c.Range().Start.Column - b.Range().Start.Column; n > 0 {
				return strings.Repeat(" ", n)
			}
		}
	}
	return "  "
}

// writeAttrs は属性を、= の位置をそろえて書く（atlas schema fmt と同じ書き方）
func writeAttrs(b *strings.Builder, indent string, attrs [][2]string) {
	width := 0
	for _, a := range attrs {
		width = max(width, len(a[0]))
	}
	for _, a := range attrs {
		fmt.Fprintf(b, "%s%-*s = %s\n", indent, width, a[0], a[1])
	}
}

// quote は HCL の文字列リテラルにする。" や \ や ${ のエスケープは hclwrite に任せる
func quote(s string) string {
	return string(hclwrite.TokensForValue(cty.StringVal(s)).Bytes())
}

func checkExpr(name, expr string) error {
	if expr == "" || strings.ContainsAny(expr, "\n\r") {
		return invalid("%s must be a single-line expression", name)
	}
	if _, diags := hclsyntax.ParseExpression([]byte(expr), "", hcl.InitialPos); diags.HasErrors() {
		return invalid("%s %q: %s", name, expr, diags.Error())
	}
	return nil
}

// lineEndAfter は off の位置から見て次の改行の直後を返す（改行が無ければファイルの末尾）
func lineEndAfter(src []byte, off int) int {
	for i := off; i < len(src); i++ {
		if src[i] == '\n' {
			return i + 1
		}
	}
	return len(src)
}

func lineStart(src []byte, off int) int {
	for i := off; i > 0; i-- {
		if src[i-1] == '\n' {
			return i
		}
	}
	return 0
}

func insert(src []byte, at int, text string) []byte {
	// ファイルの末尾が改行で終わっていなければ、先に改行を足す
	if at == len(src) && at > 0 && src[at-1] != '\n' {
		text = "\n" + text
	}
	return splice(src, at, at, text)
}

func splice(src []byte, from, to int, text string) []byte {
	out := make([]byte, 0, len(src)-(to-from)+len(text))
	out = append(out, src[:from]...)
	out = append(out, text...)
	return append(out, src[to:]...)
}
