FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dictionary-api ./cmd/dictionary-api

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/dictionary-api /dictionary-api
EXPOSE 8787
ENTRYPOINT ["/dictionary-api"]
