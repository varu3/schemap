package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/varu3/schemap/internal/source"
)

func TestSameOrigin(t *testing.T) {
	h := sameOrigin(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	cases := []struct {
		name   string
		origin string
		site   string
		want   int
	}{
		{"own page", "http://127.0.0.1:6280", "same-origin", http.StatusNoContent},
		{"other site", "https://evil.example", "cross-site", http.StatusForbidden},
		{"forged origin without fetch metadata", "http://127.0.0.1:6280", "", http.StatusForbidden},
		{"other port on localhost", "http://127.0.0.1:3000", "same-site", http.StatusForbidden},
		{"own page behind https proxy", "https://127.0.0.1:6280", "same-origin", http.StatusNoContent},
		{"other scheme-less origin", "ftp://127.0.0.1:6280", "same-origin", http.StatusForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:6280/_/api/schema", nil)
			r.Header.Set("Origin", c.origin)
			if c.site != "" {
				r.Header.Set("Sec-Fetch-Site", c.site)
			}
			w := httptest.NewRecorder()
			h(w, r)
			if w.Code != c.want {
				t.Errorf("status = %d, want %d", w.Code, c.want)
			}
		})
	}
}

// 打ち始める前の中身に、テーブルの追加とその列の追加をまとめて当てられる
func TestEditOps(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "s.hcl"), []byte("schema \"s\" {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := source.FromArgs(dir, []string{"s.hcl"})
	if err != nil {
		t.Fatal(err)
	}
	h := New(src, fstest.MapFS{}).Handler()
	post := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:6280/_/api/edit", strings.NewReader(body))
		r.Header.Set("Origin", "http://127.0.0.1:6280")
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	w := post(`{"path":"s.hcl","ops":[
		{"kind":"addTable","table":"notes","schema":"s"},
		{"kind":"addColumn","table":"notes","name":"body","type":"text","null":true}
	]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body)
	}
	var res struct {
		Sources map[string]string `json:"sources"`
		Schema  struct {
			Tables []struct {
				Name    string `json:"name"`
				Columns []struct {
					Name string `json:"name"`
				} `json:"columns"`
			} `json:"tables"`
		} `json:"schema"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Schema.Tables) != 1 || len(res.Schema.Tables[0].Columns) != 2 || res.Schema.Tables[0].Columns[1].Name != "body" {
		t.Errorf("schema = %+v", res.Schema)
	}
	// ファイルには書かない
	if b, _ := os.ReadFile(filepath.Join(dir, "s.hcl")); string(b) != "schema \"s\" {}\n" {
		t.Errorf("file changed: %s", b)
	}

	// 途中の操作が当てられなければ、全体を当てない
	w = post(`{"path":"s.hcl","ops":[
		{"kind":"addTable","table":"notes","schema":"s"},
		{"kind":"addColumn","table":"notes","name":"id","type":"text"}
	]}`)
	if w.Code != http.StatusBadRequest {
		t.Errorf("duplicate column: status = %d, want 400", w.Code)
	}
}

// テーブルを消すと、ほかのファイルにあるそのテーブルへの FK も消え、変わったファイルをすべて返す
func TestEditDeleteTableAcrossFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(name, src string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("public.hcl", "schema \"public\" {}\ntable \"shops\" {\n  schema = schema.public\n  column \"id\" {\n    type = serial\n  }\n}\n")
	write("tenant.hcl", "schema \"t\" {}\ntable \"items\" {\n  schema = schema.t\n  column \"shop_id\" {\n    type = integer\n  }\n  foreign_key \"items_shop_id_fkey\" {\n    columns     = [column.shop_id]\n    ref_columns = [table.shops.column.id]\n  }\n}\n")
	src, err := source.FromArgs(dir, []string{"."})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:6280/_/api/edit",
		strings.NewReader(`{"path":"public.hcl","ops":[{"kind":"deleteTable","table":"shops"}]}`))
	r.Header.Set("Origin", "http://127.0.0.1:6280")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	New(src, fstest.MapFS{}).Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body)
	}
	var res struct {
		Sources map[string]string `json:"sources"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Sources["public.hcl"], "shops") || strings.Contains(res.Sources["tenant.hcl"], "foreign_key") {
		t.Errorf("sources = %+v", res.Sources)
	}
	if !strings.Contains(res.Sources["tenant.hcl"], `table "items"`) {
		t.Errorf("items removed: %s", res.Sources["tenant.hcl"])
	}
}

// 公開しないときは localhost 以外の Host を拒否し、公開するときは受け付ける
func TestLocalOnlyUnlessPublic(t *testing.T) {
	for _, c := range []struct {
		name   string
		public bool
		host   string
		want   int
	}{
		{"local", false, "127.0.0.1:6280", http.StatusOK},
		{"rebinding", false, "evil.example", http.StatusForbidden},
		{"public", true, "schemap.example.com", http.StatusOK},
	} {
		t.Run(c.name, func(t *testing.T) {
			sv := New(nil, fstest.MapFS{"index.html": {Data: []byte("ok")}})
			sv.Public = c.public
			r := httptest.NewRequest(http.MethodGet, "http://"+c.host+"/", nil)
			w := httptest.NewRecorder()
			sv.Handler().ServeHTTP(w, r)
			if w.Code != c.want {
				t.Errorf("status = %d, want %d", w.Code, c.want)
			}
		})
	}
}
