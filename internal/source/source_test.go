package source

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/varu3/schemap/internal/schema"
)

func TestFromArgs(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"schema/b.hcl", "schema/a.hcl", "schema/memo.txt", "extra.hcl"} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(`schema "s" {}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	s, err := FromArgs(dir, []string{"schema", "extra.hcl", "schema/a.hcl"})
	if err != nil {
		t.Fatal(err)
	}
	// ディレクトリは中の *.hcl を名前順に読み、同じファイルは 1 回だけにする
	want := []string{"schema/a.hcl", "schema/b.hcl", "extra.hcl"}
	if got := s.Paths(); !slices.Equal(got, want) {
		t.Errorf("paths = %v, want %v", got, want)
	}
	files, err := s.Files()
	if err != nil || len(files) != 3 || files[0].Path != "schema/a.hcl" {
		t.Errorf("files = %v, err = %v", files, err)
	}

	if _, err := FromArgs(dir, []string{"missing.hcl"}); err == nil {
		t.Error("missing file should be an error")
	}
	empty := filepath.Join(dir, "empty")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := FromArgs(dir, []string{"empty"}); err == nil {
		t.Error("directory without *.hcl should be an error")
	}
}

func TestWrite(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.hcl")
	if err := os.WriteFile(p, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	s, err := FromArgs(dir, []string{"a.hcl"})
	if err != nil {
		t.Fatal(err)
	}
	base := schema.Hash([]byte("old"))

	if err := s.Write("a.hcl", []byte("new"), base); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	info, _ := os.Stat(p)
	if string(got) != "new" || info.Mode().Perm() != 0o640 {
		t.Errorf("content = %q, mode = %v", got, info.Mode().Perm())
	}
	// 書いたあとのディスクは "new" なので、古い base では上書きできない
	if err := s.Write("a.hcl", []byte("other"), base); !errors.Is(err, ErrConflict) {
		t.Errorf("err = %v, want ErrConflict", err)
	}
	if err := s.Write("../b.hcl", []byte("x"), base); !errors.Is(err, ErrUnknownFile) {
		t.Errorf("err = %v, want ErrUnknownFile", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temporary files left: %v", entries)
	}
}
