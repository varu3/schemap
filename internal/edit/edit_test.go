package edit

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/varu3/schemap/internal/schema"
)

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	src, err := os.ReadFile(filepath.Join("..", "schema", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return src
}

// parseWith は public.hcl と、name を out に差し替えた tenant.hcl / public.hcl をまとめて読む
func parseWith(t *testing.T, name string, out []byte) *schema.Schema {
	t.Helper()
	files := []schema.File{
		{Path: "public.hcl", Src: readTestdata(t, "public.hcl")},
		{Path: "tenant.hcl", Src: readTestdata(t, "tenant.hcl")},
	}
	for i := range files {
		if files[i].Path == name {
			files[i].Src = out
		}
	}
	s, err := schema.Parse(files)
	if err != nil {
		t.Fatalf("result does not parse: %v\n%s", err, out)
	}
	return s
}

// assertSplice は out が src の 1 か所だけを変えたものであることを確かめる（前後のバイトはそのまま）
func assertSplice(t *testing.T, src, out []byte, removed int) {
	t.Helper()
	cp := 0
	for cp < len(src) && cp < len(out) && src[cp] == out[cp] {
		cp++
	}
	cs := 0
	for cs < len(src)-cp && cs < len(out)-cp && src[len(src)-1-cs] == out[len(out)-1-cs] {
		cs++
	}
	if cp+cs < len(src)-removed {
		t.Errorf("bytes outside the edit changed: common prefix %d + suffix %d < %d", cp, cs, len(src)-removed)
	}
}

func apply(t *testing.T, name string, op Op) []byte {
	t.Helper()
	src := readTestdata(t, name)
	out, err := Apply(src, op)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAddTable(t *testing.T) {
	src := readTestdata(t, "tenant.hcl")
	out := apply(t, "tenant.hcl", Op{Kind: "addTable", Table: "notes", Schema: "tenant", Comment: "メモ"})
	assertSplice(t, src, out, 0)
	s := parseWith(t, "tenant.hcl", out)
	tb := s.Table("notes")
	if tb == nil || tb.Schema != "tenant" || tb.Comment != "メモ" || len(tb.Columns) != 1 || tb.PrimaryKey[0] != "id" {
		t.Fatalf("table = %+v", tb)
	}
	// 最後の table（orders）の後ろ、trigger の前に入る
	if i, j := strings.Index(string(out), `table "notes"`), strings.Index(string(out), `trigger "`); i > j {
		t.Errorf("new table should come before triggers")
	}

	for _, op := range []Op{
		{Kind: "addTable", Table: "products", Schema: "tenant"},
		{Kind: "addTable", Table: "notes", Schema: "public"}, // tenant.hcl では public を宣言していない
		{Kind: "addTable", Table: "bad-name", Schema: "tenant"},
	} {
		if _, err := Apply(src, op); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: err = %v, want ErrInvalid", op, err)
		}
	}
}

func TestAddColumn(t *testing.T) {
	src := readTestdata(t, "tenant.hcl")
	out := apply(t, "tenant.hcl", Op{
		Kind: "addColumn", Table: "products", Name: "memo", Type: "text", Null: true,
		Default: `""`, Comment: `"引用" と ${x}`,
	})
	assertSplice(t, src, out, 0)
	cols := parseWith(t, "tenant.hcl", out).Table("products").Columns
	memo := cols[len(cols)-1]
	if memo.Name != "memo" || memo.Type != "text" || !memo.Null || memo.Default != `""` || memo.Comment != `"引用" と ${x}` {
		t.Errorf("column = %+v", memo)
	}

	for _, op := range []Op{
		{Kind: "addColumn", Table: "products", Name: "name", Type: "text"},
		{Kind: "addColumn", Table: "products", Name: "x", Type: "varchar("},
		{Kind: "addColumn", Table: "products", Name: "x", Type: "text\nfoo"},
		{Kind: "addColumn", Table: "nope", Name: "x", Type: "text"},
	} {
		if _, err := Apply(src, op); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: err = %v, want ErrInvalid", op, err)
		}
	}
}

func TestAddForeignKey(t *testing.T) {
	// 既存の FK の後ろに入る
	src := readTestdata(t, "tenant.hcl")
	out := apply(t, "tenant.hcl", Op{Kind: "addForeignKey", Table: "orders", Columns: []string{"item_id"}, RefTable: "products", RefColumns: []string{"id"}})
	assertSplice(t, src, out, 0)
	fks := parseWith(t, "tenant.hcl", out).Table("orders").ForeignKeys
	// 同じ列の FK がすでにあるので、名前は _2 になる
	if last := fks[len(fks)-1]; last.Name != "orders_item_id_fkey_2" || last.RefTable != "products" || last.OnDelete != "RESTRICT" {
		t.Errorf("fk = %+v", last)
	}

	// FK が無ければ主キーの後ろ、主キーも無ければ最後の列の後ろに入る
	cases := map[string]string{
		"after primary_key": "schema \"s\" {}\ntable \"a\" {\n  schema = schema.s\n  column \"id\" {\n    type = serial\n  }\n  column \"b_id\" {\n    type = integer\n  }\n  primary_key {\n    columns = [column.id]\n  }\n}\n",
		"after column":      "schema \"s\" {}\ntable \"a\" {\n  schema = schema.s\n  column \"b_id\" {\n    type = integer\n  }\n}\n",
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			out, err := Apply([]byte(src), Op{Kind: "addForeignKey", Table: "a", Columns: []string{"b_id"}, RefTable: "b", RefColumns: []string{"id"}, OnDelete: "CASCADE"})
			if err != nil {
				t.Fatal(err)
			}
			assertSplice(t, []byte(src), out, 0)
			want := "  foreign_key \"a_b_id_fkey\" {\n    columns     = [column.b_id]\n    ref_columns = [table.b.column.id]\n    on_update   = RESTRICT\n    on_delete   = CASCADE\n  }\n}\n"
			if !strings.HasSuffix(string(out), want) {
				t.Errorf("out =\n%s", out)
			}
		})
	}

	for _, op := range []Op{
		{Kind: "addForeignKey", Table: "orders", Columns: []string{"nope"}, RefTable: "products", RefColumns: []string{"id"}},
		{Kind: "addForeignKey", Table: "orders", Columns: []string{"item_id"}, RefTable: "products", RefColumns: nil},
		{Kind: "addForeignKey", Table: "orders", Columns: []string{"item_id"}, RefTable: "products", RefColumns: []string{"id"}, OnDelete: "DROP"},
	} {
		if _, err := Apply(src, op); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: err = %v, want ErrInvalid", op, err)
		}
	}
}

func TestSetComment(t *testing.T) {
	pub := readTestdata(t, "public.hcl")
	ten := readTestdata(t, "tenant.hcl")
	cases := []struct {
		name    string
		file    string
		src     []byte
		op      Op
		removed int
		check   func(*schema.Schema) bool
	}{
		{"replace table comment", "public.hcl", pub, Op{Kind: "setComment", Table: "shops", Comment: "支店"}, len(`"店舗"`),
			func(s *schema.Schema) bool { return s.Table("shops").Comment == "支店" }},
		{"add table comment after schema", "tenant.hcl", ten, Op{Kind: "setComment", Table: "products", Comment: "商品"}, 0,
			func(s *schema.Schema) bool { return s.Table("products").Comment == "商品" }},
		{"remove column comment", "tenant.hcl", ten, Op{Kind: "setComment", Table: "products", Column: "name"}, len("    comment = \"商品名\"\n"),
			func(s *schema.Schema) bool { return s.Table("products").Columns[2].Comment == "" }},
		{"add column comment after last attribute", "tenant.hcl", ten, Op{Kind: "setComment", Table: "products", Column: "price", Comment: "単価"}, 0,
			func(s *schema.Schema) bool { return s.Table("products").Columns[3].Comment == "単価" }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := Apply(c.src, c.op)
			if err != nil {
				t.Fatal(err)
			}
			assertSplice(t, c.src, out, c.removed)
			if !c.check(parseWith(t, c.file, out)) {
				t.Errorf("out =\n%s", out)
			}
		})
	}
	// コメントを消したら、属性の行ごと無くなる（空の行を残さない）
	out, _ := Apply(ten, Op{Kind: "setComment", Table: "products", Column: "name"})
	if strings.Contains(string(out), "    type    = character_varying(255)\n\n") {
		t.Errorf("blank line left after removing comment")
	}
}

func TestAddTablePrimaryKey(t *testing.T) {
	out := apply(t, "tenant.hcl", Op{Kind: "addTable", Table: "notes", Schema: "tenant", Name: "note_id", Type: "bigserial"})
	tb := parseWith(t, "tenant.hcl", out).Table("notes")
	if len(tb.Columns) != 1 || tb.Columns[0].Name != "note_id" || tb.Columns[0].Type != "bigserial" || tb.PrimaryKey[0] != "note_id" {
		t.Fatalf("table = %+v", tb)
	}
	if _, err := Apply(readTestdata(t, "tenant.hcl"), Op{Kind: "addTable", Table: "notes", Schema: "tenant", Name: "bad-name"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("err = %v, want ErrInvalid", err)
	}
}

func TestDeleteTable(t *testing.T) {
	out := apply(t, "tenant.hcl", Op{Kind: "deleteTable", Table: "products"})
	s := parseWith(t, "tenant.hcl", out)
	if s.Table("products") != nil {
		t.Fatal("products still exists")
	}
	// products への FK と、products の trigger も消える。ほかの FK は残る
	fks := s.Table("orders").ForeignKeys
	if len(fks) != 1 || fks[0].Name != "orders_parent_id_fkey" {
		t.Errorf("orders fks = %+v", fks)
	}
	if strings.Contains(string(out), "set_products_updated_at") {
		t.Error("trigger on products left")
	}
	// 消したブロックの行のほかは変わらない
	for _, keep := range []string{"table \"orders\" {\n", "  foreign_key \"orders_parent_id_fkey\" {\n"} {
		if !strings.Contains(string(out), keep) {
			t.Errorf("%q changed", keep)
		}
	}
	if strings.Contains(string(out), "\n\n\n") {
		t.Error("blank lines left")
	}

	// 参照しているだけのファイル（public.hcl に shops がある）では、tenant.hcl の FK だけが消える
	out = apply(t, "tenant.hcl", Op{Kind: "deleteTable", Table: "shops"})
	if fks := parseWith(t, "tenant.hcl", out).Table("products").ForeignKeys; len(fks) != 0 {
		t.Errorf("products fks = %+v", fks)
	}
	// 何も参照していないファイルはそのまま
	pub := readTestdata(t, "public.hcl")
	if got, _ := Apply(pub, Op{Kind: "deleteTable", Table: "products"}); string(got) != string(pub) {
		t.Error("public.hcl changed")
	}
}

func TestDeleteForeignKey(t *testing.T) {
	src := readTestdata(t, "tenant.hcl")
	out := apply(t, "tenant.hcl", Op{Kind: "deleteForeignKey", Table: "orders", Name: "orders_item_id_fkey"})
	fks := parseWith(t, "tenant.hcl", out).Table("orders").ForeignKeys
	if len(fks) != 1 || fks[0].Name != "orders_parent_id_fkey" {
		t.Errorf("fks = %+v", fks)
	}
	removed := len(src) - len(out)
	assertSplice(t, src, out, removed)
	if _, err := Apply(src, Op{Kind: "deleteForeignKey", Table: "orders", Name: "nope"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("err = %v, want ErrInvalid", err)
	}
}
