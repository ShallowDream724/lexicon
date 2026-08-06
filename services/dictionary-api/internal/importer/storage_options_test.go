package importer

import "testing"

func TestStorageOptionsAcceptBenchmarkDictionarySizes(t *testing.T) {
	for _, size := range []int{64 * 1024, 128 * 1024} {
		options, err := (StorageOptions{DictionarySize: size}).normalized()
		if err != nil {
			t.Fatalf("dictionary size %d: %v", size, err)
		}
		if options.DictionarySize != size {
			t.Fatalf("dictionary size = %d, want %d", options.DictionarySize, size)
		}
	}
}

func TestStorageOptionsDefaultToRecommendedRuntimeLayout(t *testing.T) {
	options, err := (StorageOptions{}).normalized()
	if err != nil {
		t.Fatal(err)
	}
	if options.PageSize != 8*1024 || options.CompressionLevel != 7 || options.DictionarySize != 64*1024 {
		t.Fatalf("default storage options = %#v", options)
	}
}
