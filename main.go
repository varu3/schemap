// schemap は Atlas HCL を ER 図として表示し、編集できるローカルツール。
//
//	schemap [flags] <ファイルまたはディレクトリ> ...
//
// ディレクトリを渡すと中の *.hcl を読む。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/varu3/schemap/internal/server"
	"github.com/varu3/schemap/internal/source"
	"github.com/varu3/schemap/internal/static"
)

func main() {
	if err := run(); err != nil {
		slog.Error("schemap", "error", err)
		os.Exit(1)
	}
}

func run() error {
	port := flag.Int("port", 6280, "待ち受けるポート（127.0.0.1 のみ）")
	noOpen := flag.Bool("no-open", false, "起動時にブラウザを開かない")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "使い方: schemap [flags] <ファイルまたはディレクトリ> ...")
		flag.PrintDefaults()
	}
	paths := parseArgs(os.Args[1:])
	if len(paths) == 0 {
		flag.Usage()
		return errors.New("読む HCL のファイルかディレクトリを指定してください")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	src, err := source.FromArgs(wd, paths)
	if err != nil {
		return err
	}
	assets, err := fs.Sub(static.Frontend, "dist")
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/", *port)
	srv := &http.Server{Handler: server.New(src, assets).Handler(), ReadHeaderTimeout: 10 * time.Second}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	fmt.Printf("schemap: %s (%s)\n", url, strings.Join(src.Paths(), ", "))
	if !*noOpen {
		openBrowser(url)
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// parseArgs はフラグとパスを分ける。パスの後ろに置いたフラグも読む
// （mise のタスクは引数をコマンドの末尾に付けるので、`schemap db/schema -port 6281` の形になる）。
func parseArgs(args []string) []string {
	var paths []string
	for {
		// ExitOnError なので、不正なフラグはここで使い方を出して終わる
		_ = flag.CommandLine.Parse(args)
		rest := flag.Args()
		if len(rest) == 0 {
			return paths
		}
		paths = append(paths, rest[0])
		args = rest[1:]
	}
}

func openBrowser(url string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	if err := exec.Command(name, url).Start(); err != nil {
		slog.Warn("ブラウザを開けませんでした", "url", url, "error", err)
	}
}
