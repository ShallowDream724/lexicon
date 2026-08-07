package payload

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestImplementationMatchesZstdDependency(t *testing.T) {
	module, err := os.ReadFile("../../go.mod")
	if err != nil {
		t.Fatal(err)
	}
	moduleVersion := strings.TrimPrefix(Implementation, "github.com/klauspost/compress@")
	if moduleVersion == Implementation {
		t.Fatalf("invalid implementation metadata %q", Implementation)
	}
	declaration := "github.com/klauspost/compress " + moduleVersion
	if !strings.Contains(string(module), declaration) {
		t.Fatalf("implementation metadata %q does not match go.mod", Implementation)
	}
}

func TestZstdDecompressHonorsExpectedSizeCapacity(t *testing.T) {
	codec, err := NewZstd(nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := bytes.Repeat([]byte("bounded payload "), 1024)
	compressed, err := codec.Compress(raw)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := codec.Decompress(compressed, int64(len(raw)))
	if err != nil || !bytes.Equal(decoded, raw) {
		t.Fatalf("valid payload did not round-trip: bytes=%d err=%v", len(decoded), err)
	}
	if decoded, err := codec.Decompress(compressed, 1); err == nil || decoded != nil {
		t.Fatalf("oversized decoded payload was accepted: bytes=%d err=%v", len(decoded), err)
	}
}
