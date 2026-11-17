# syntax=docker/dockerfile:1
# schemap を公開して動かすイメージ。サンプルの EC サイト（examples/ec）を開き、8080 番で待ち受ける。
#   docker build -t schemap . && docker run --rm -p 8080:8080 schemap
# ほかのスキーマを開くときは、ディレクトリをマウントしてパスを渡す。
#   docker run --rm -p 8080:8080 -v "$PWD/db/schema:/home/nonroot/schema" schemap schema

# 画面。どのプラットフォーム向けでも中身は同じなので、ビルドするマシンの上で 1 回だけ作る
FROM --platform=$BUILDPLATFORM node:22.23.4-bookworm-slim AS frontend
RUN npm install -g pnpm@10.10.0
WORKDIR /src/internal/frontend
COPY internal/frontend/package.json internal/frontend/pnpm-lock.yaml internal/frontend/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY internal/frontend/ ./
# ../static/dist（/src/internal/static/dist）に出る
RUN pnpm run build

# Go のバイナリ。CGO を使わないので、ビルドするマシンの上で各プラットフォーム向けに作る
FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/internal/static/dist ./internal/static/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w" -o /out/schemap .

FROM gcr.io/distroless/static-debian13:nonroot
LABEL org.opencontainers.image.source="https://github.com/varu3/schemap"
LABEL org.opencontainers.image.description="Atlas HCL を ER 図で見て編集するツール"
COPY --from=build /out/schemap /usr/local/bin/schemap
# 画面の「保存」は同じディレクトリに一時ファイルを作るので、ディレクトリごと nonroot に書けるようにする
COPY --chown=nonroot:nonroot examples/ec /home/nonroot/ec
WORKDIR /home/nonroot
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/schemap", "-host", "0.0.0.0", "-port", "8080"]
CMD ["ec"]
