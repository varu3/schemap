// Package server は画面と、スキーマを JSON で返す API を配る。
package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"

	"github.com/varu3/schemap/internal/edit"
	"github.com/varu3/schemap/internal/engine"
	"github.com/varu3/schemap/internal/schema"
	"github.com/varu3/schemap/internal/source"
)

type Server struct {
	src    *source.Source
	assets fs.FS
	// Public が true なら、localhost 以外の Host も受け付ける（コンテナで公開するとき）
	Public bool
}

func New(src *source.Source, assets fs.FS) *Server {
	return &Server{src: src, assets: assets}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /_/api/schema", s.getSchema)
	mux.HandleFunc("POST /_/api/schema", sameOrigin(s.parseEdited))
	mux.HandleFunc("POST /_/api/save", sameOrigin(s.save))
	mux.HandleFunc("POST /_/api/edit", sameOrigin(s.edit))
	mux.Handle("GET /", http.FileServerFS(s.assets))
	if s.Public {
		return mux
	}
	return localOnly(mux)
}

type schemaRequest struct {
	// Overrides は編集中のファイルの中身（画面に出しているファイル名 → 中身）。ファイルには書き込まない
	Overrides map[string]string `json:"overrides"`
}

type parseErrorResponse struct {
	Error      string             `json:"error"`
	ParseError *schema.ParseError `json:"parseError"`
}

// maxRequestBytes は編集中のファイルを受け取る上限。数百 KB のスキーマファイルが入る大きさにする
const maxRequestBytes = 8 << 20

// getSchema は作業ツリーの db/schema を解析して返す。
func (s *Server) getSchema(w http.ResponseWriter, _ *http.Request) {
	files, err := s.src.Files()
	if err != nil {
		writeServerError(w, err)
		return
	}
	writeParsed(w, files)
}

// parseEdited は getSchema と同じだが、ファイルを編集中の中身に差し替えてから解析する。
// 構文エラーなら 422 とエラーの位置を返す。
func (s *Server) parseEdited(w http.ResponseWriter, r *http.Request) {
	var req schemaRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	files, err := s.src.Files()
	if err != nil {
		writeServerError(w, err)
		return
	}
	sc, err := engine.Parse(files, req.Overrides)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, sc)
}

type editRequest struct {
	// Path は操作するファイル
	Path string `json:"path"`
	// Overrides は編集中のファイルの中身。操作はこの中身（無ければディスク）に当てる
	Overrides map[string]string `json:"overrides"`
	// Ops は順に当てる操作。画面は打っている途中の内容を、打ち始める前の中身から毎回当て直す
	Ops []edit.Op `json:"ops"`
}

// edit は画面の操作を HCL に当て、当てたあとの中身と解析したスキーマを返す。ファイルには書かない。
func (s *Server) edit(w http.ResponseWriter, r *http.Request) {
	var req editRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	files, err := s.src.Files()
	if err != nil {
		writeServerError(w, err)
		return
	}
	res, err := engine.Edit(files, req.Path, req.Overrides, req.Ops)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, res)
}

type saveRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// Base は読み込んだときの中身のハッシュ。ディスクの今の中身と違えば保存しない
	Base string `json:"base"`
}

// save は編集した中身をファイルに書く。書けるのは起動時に指定したファイルだけ。
// 読み込んでからディスクのファイルが変わっていれば 409 を返す。
func (s *Server) save(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	err := s.src.Write(req.Path, []byte(req.Content), req.Base)
	switch {
	case errors.Is(err, source.ErrUnknownFile):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, source.ErrConflict):
		writeError(w, http.StatusConflict, err.Error())
	case err != nil:
		writeServerError(w, err)
	default:
		writeJSON(w, map[string]string{"hash": schema.Hash([]byte(req.Content))})
	}
}

func writeParsed(w http.ResponseWriter, files []schema.File) {
	sc, err := engine.Parse(files, nil)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, sc)
}

// writeEngineError は engine のエラーを、構文エラーなら 422、内容の誤りなら 400、ほかは 500 で返す。
func writeEngineError(w http.ResponseWriter, err error) {
	var pe *schema.ParseError
	switch {
	case errors.As(err, &pe):
		writeParseError(w, pe)
	case errors.Is(err, engine.ErrBadRequest):
		writeError(w, http.StatusBadRequest, engine.Message(err))
	default:
		writeServerError(w, err)
	}
}

func writeParseError(w http.ResponseWriter, pe *schema.ParseError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	_ = json.NewEncoder(w).Encode(parseErrorResponse{Error: pe.Error(), ParseError: pe})
}

func writeServerError(w http.ResponseWriter, err error) {
	slog.Error("load schema", "error", err)
	writeError(w, http.StatusInternalServerError, err.Error())
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// sameOrigin は、このサーバー自身の画面から送られたリクエストだけを通す。
// localhost で待ち受けていても、ブラウザで開いた外部のページから POST できてしまうため。
// HTTPS で終端するプロキシの後ろに置いたときは、Origin が https:// になる。
func sameOrigin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if r.Header.Get("Sec-Fetch-Site") != "same-origin" || (origin != "http://"+r.Host && origin != "https://"+r.Host) {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		next(w, r)
	}
}

// localOnly は Host が localhost / 127.0.0.1 以外のリクエストを拒否する。
// 外部のページが DNS rebinding でこのサーバーを読むのを防ぐ。
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
