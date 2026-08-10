FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dictionary-api ./cmd/dictionary-api \
    && mkdir -p /out/cache

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/dictionary-api /dictionary-api
COPY --from=build --chown=65532:65532 /out/cache /var/cache/lexicon
EXPOSE 8787
ENTRYPOINT ["/dictionary-api"]
