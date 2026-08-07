package main

import (
	"path/filepath"
	"testing"
)

func TestOpenOptionalEtymologyAllowsMissingSidecar(t *testing.T) {
	store, err := openOptionalEtymology(filepath.Join(t.TempDir(), "missing.db"))
	if err != nil || store != nil {
		t.Fatalf("missing optional sidecar should be ignored: store=%v err=%v", store, err)
	}
}
