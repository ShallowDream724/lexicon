package payload

import (
	"bytes"
	"testing"
)

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
