package engine

import (
	"errors"
	"strings"
	"testing"

	"github.com/varu3/schemap/internal/edit"
	"github.com/varu3/schemap/internal/schema"
)

func files() []schema.File {
	return []schema.File{
		{Path: "public.hcl", Src: []byte("schema \"public\" {}\ntable \"shops\" {\n  schema = schema.public\n  column \"id\" {\n    type = serial\n  }\n}\n")},
		{Path: "tenant.hcl", Src: []byte("schema \"t\" {}\n")},
	}
}

// overrides で差し替えた中身を解析し、渡した files は書き換えない
func TestParseOverrides(t *testing.T) {
	in := files()
	sc, err := Parse(in, map[string]string{"tenant.hcl": "schema \"t\" {}\ntable \"items\" {\n  schema = schema.t\n}\n"})
	if err != nil {
		t.Fatal(err)
	}
	if sc.Table("items") == nil || sc.Table("shops") == nil {
		t.Errorf("tables = %+v", sc.Tables)
	}
	if string(in[1].Src) != "schema \"t\" {}\n" {
		t.Errorf("input changed: %s", in[1].Src)
	}
}

func TestParseErrors(t *testing.T) {
	if _, err := Parse(files(), map[string]string{"nope.hcl": ""}); !errors.Is(err, ErrBadRequest) || Message(err) != "unknown file: nope.hcl" {
		t.Errorf("unknown file: err = %v", err)
	}
	var pe *schema.ParseError
	if _, err := Parse(files(), map[string]string{"tenant.hcl": "table \"x\" {"}); !errors.As(err, &pe) || pe.File != "tenant.hcl" {
		t.Errorf("syntax error: err = %v", err)
	}
}

// 操作は overrides の中身に当て、変わったファイルだけを返す。渡した files は書き換えない
func TestEdit(t *testing.T) {
	in := files()
	res, err := Edit(in, "tenant.hcl", nil, []edit.Op{
		{Kind: "addTable", Table: "items", Schema: "t"},
		{Kind: "addColumn", Table: "items", Name: "shop_id", Type: "integer"},
		{Kind: "addForeignKey", Table: "items", Columns: []string{"shop_id"}, RefTable: "shops", RefColumns: []string{"id"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Sources) != 1 || !strings.Contains(res.Sources["tenant.hcl"], "foreign_key") {
		t.Errorf("sources = %+v", res.Sources)
	}
	if res.Schema.Table("items") == nil {
		t.Errorf("items not parsed")
	}
	if string(in[1].Src) != "schema \"t\" {}\n" {
		t.Errorf("input changed: %s", in[1].Src)
	}

	// テーブルを消すと、ほかのファイルにあるそのテーブルへの FK も消える
	res, err = Edit(in, "public.hcl", res.Sources, []edit.Op{{Kind: "deleteTable", Table: "shops"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Sources["public.hcl"], "shops") || strings.Contains(res.Sources["tenant.hcl"], "foreign_key") {
		t.Errorf("sources = %+v", res.Sources)
	}
}

func TestEditErrors(t *testing.T) {
	cases := map[string][]edit.Op{
		"table \"shops\" already exists": {{Kind: "addTable", Table: "shops", Schema: "public"}},
		"table \"nope\" not found":       {{Kind: "deleteTable", Table: "nope"}},
		"ref table \"nope\" not found":   {{Kind: "addForeignKey", Table: "shops", Columns: []string{"id"}, RefTable: "nope", RefColumns: []string{"id"}}},
	}
	for want, ops := range cases {
		if _, err := Edit(files(), "public.hcl", nil, ops); !errors.Is(err, ErrBadRequest) || Message(err) != want {
			t.Errorf("err = %v, want %q", err, want)
		}
	}
	if _, err := Edit(files(), "nope.hcl", nil, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("unknown file: err = %v", err)
	}
}
