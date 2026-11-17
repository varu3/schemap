package schema

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixture = `
schema "tenant" {}

table "products" {
  schema = schema.tenant
  column "id" {
    type = serial
  }
  column "price" {
    null    = true
    type    = numeric(5,4)
    default = 0
  }
  column "shop_id" {
    type = integer
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "products_shop_id_fkey" {
    columns     = [column.shop_id]
    ref_columns = [table.shops.column.id]
    on_update   = RESTRICT
    on_delete   = CASCADE
  }
  index "products_name_trgm" {
    type = GIN
    on {
      column = column.price
      ops    = "public.gin_trgm_ops"
    }
  }
  unique "products_shop_unique" {
    columns = [column.shop_id, column.id]
  }
}

enum "item_status" {
  schema = schema.tenant
  values = ["A", "B"]
}
`

func TestParse(t *testing.T) {
	s, err := Parse([]File{{Path: "tenant.hcl", Src: []byte(fixture)}})
	if err != nil {
		t.Fatal(err)
	}
	tb := s.Table("products")
	if tb == nil {
		t.Fatal("products not found")
	}
	if tb.Schema != "tenant" {
		t.Errorf("schema = %q", tb.Schema)
	}
	price := tb.Columns[1]
	if price.Type != "numeric(5,4)" || !price.Null || price.Default != "0" {
		t.Errorf("price = %+v", price)
	}
	if string([]byte(fixture)[tb.Range.Start:tb.Range.Start+5]) != "table" {
		t.Errorf("range does not point at the table block: %+v", tb.Range)
	}
	if lines := strings.Split(fixture, "\n"); !strings.HasPrefix(lines[tb.Range.Line-1], `table "products"`) ||
		lines[tb.Range.EndLine-1] != "}" {
		t.Errorf("lines %d-%d do not cover the table block", tb.Range.Line, tb.Range.EndLine)
	}
	fk := tb.ForeignKeys[0]
	if fk.RefTable != "shops" || fk.RefColumns[0] != "id" || fk.OnDelete != "CASCADE" {
		t.Errorf("fk = %+v", fk)
	}
	if got := tb.Indexes[0].Columns; len(got) != 1 || got[0] != "price" {
		t.Errorf("index columns = %v", got)
	}
	if u := tb.Uniques[0]; !u.Unique || len(u.Columns) != 2 {
		t.Errorf("unique = %+v", u)
	}
	if e := s.Enums[0]; e.Name != "item_status" || len(e.Values) != 2 || e.Values[1] != "B" {
		t.Errorf("enum = %+v", e)
	}
}

// TestParseTestdata は testdata の HCL（よく使う書き方を集めたもの）を、
// ファイルをまたいだ参照も含めて読めることを確かめる。
func TestParseTestdata(t *testing.T) {
	var files []File
	for _, name := range []string{"public.hcl", "tenant.hcl"} {
		src, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, File{Path: name, Src: src})
	}
	s, err := Parse(files)
	if err != nil {
		t.Fatal(err)
	}
	var cols, fks int
	for _, tb := range s.Tables {
		cols += len(tb.Columns)
		fks += len(tb.ForeignKeys)
		for _, fk := range tb.ForeignKeys {
			if s.Table(fk.RefTable) == nil {
				t.Errorf("%s.%s refers to unknown table %q", tb.Name, fk.Name, fk.RefTable)
			}
		}
	}
	if len(s.Tables) != 3 || cols != 11 || fks != 3 || len(s.Enums) != 1 || len(s.Files) != 2 {
		t.Errorf("tables=%d columns=%d fks=%d enums=%d files=%d", len(s.Tables), cols, fks, len(s.Enums), len(s.Files))
	}
	if c := s.Table("products").Columns[2]; c.Type != "character_varying(255)" {
		t.Errorf("type = %q", c.Type)
	}
	if c := s.Table("shops").Comment; c != "店舗" {
		t.Errorf("table comment = %q", c)
	}
	if c := s.Table("products").Columns[2].Comment; c != "商品名" {
		t.Errorf("column comment = %q", c)
	}
	if fk := s.Table("orders").ForeignKeys[1]; fk.RefTable != "orders" || fk.OnDelete != "SET_NULL" {
		t.Errorf("self fk = %+v", fk)
	}
	if idx := s.Table("orders").Indexes[0]; idx.Where != "(parent_id IS NULL)" {
		t.Errorf("where = %q", idx.Where)
	}
}
