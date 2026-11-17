// Package source は、起動時に指定されたファイル・ディレクトリから画面に出す HCL ファイルを読む。
package source

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/varu3/schemap/internal/schema"
)

// Source は読むファイルの一覧。Path（画面に出す名前）は起動したディレクトリからの相対パス。
type Source struct {
	files []entry
}

type entry struct {
	path    string // 画面とエディタの保存に使う名前
	absPath string
}

// FromArgs は引数のファイルとディレクトリ（中の *.hcl）を読む Source を作る。
func FromArgs(cwd string, args []string) (*Source, error) {
	var abs []string
	for _, a := range args {
		p := a
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, p)
		}
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			abs = append(abs, p)
			continue
		}
		found, err := filepath.Glob(filepath.Join(p, "*.hcl"))
		if err != nil {
			return nil, err
		}
		if len(found) == 0 {
			return nil, fmt.Errorf("%s に *.hcl がありません", a)
		}
		sort.Strings(found)
		abs = append(abs, found...)
	}
	return newSource(cwd, abs)
}

func newSource(cwd string, abs []string) (*Source, error) {
	s := &Source{}
	seen := map[string]bool{}
	for _, p := range abs {
		// 起動した場所の外でも、../ を含む相対パスで出す（絶対パスは画面で長すぎる）
		name := p
		if rel, err := filepath.Rel(cwd, p); err == nil {
			name = rel
		}
		name = filepath.ToSlash(name)
		if seen[name] {
			continue
		}
		seen[name] = true
		s.files = append(s.files, entry{path: name, absPath: p})
	}
	if len(s.files) == 0 {
		return nil, errors.New("読む HCL ファイルがありません")
	}
	return s, nil
}

// Paths は画面に出す名前の一覧。
func (s *Source) Paths() []string {
	out := make([]string, len(s.files))
	for i, f := range s.files {
		out[i] = f.path
	}
	return out
}

// Files は各ファイルの今の中身を読む。
func (s *Source) Files() ([]schema.File, error) {
	files := make([]schema.File, 0, len(s.files))
	for _, f := range s.files {
		src, err := os.ReadFile(f.absPath)
		if err != nil {
			return nil, err
		}
		files = append(files, schema.File{Path: f.path, Src: src})
	}
	return files, nil
}

var (
	ErrUnknownFile = errors.New("unknown file")
	// ErrConflict は、読み込んでからディスクのファイルが変わっていたことを表す
	ErrConflict = errors.New("file changed on disk")
)

// Write は path（画面に出している名前）のファイルに content を書く。
// ディスクの今の中身のハッシュが base と違えば、上書きせずに ErrConflict を返す。
// 一時ファイルに書いてから置き換えるので、途中で失敗しても元のファイルは壊れない。
func (s *Source) Write(path string, content []byte, base string) error {
	var target string
	for _, f := range s.files {
		if f.path == path {
			target = f.absPath
		}
	}
	if target == "" {
		return fmt.Errorf("%w: %s", ErrUnknownFile, path)
	}
	current, err := os.ReadFile(target)
	if err != nil {
		return err
	}
	if schema.Hash(current) != base {
		return ErrConflict
	}
	if bytes.Equal(current, content) {
		return nil
	}
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), info.Mode().Perm()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}
