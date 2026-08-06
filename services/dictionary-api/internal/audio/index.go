package audio

import (
	"archive/zip"
	"errors"
	"io"
	"path"
	"strings"
)

var ErrNotFound = errors.New("audio asset not found")

// Index retains the archive handle and maps an unambiguous pronunciation key
// (the filename without .mp3) to its ZIP member.
type Index struct {
	archive *zip.ReadCloser
	files   map[string]*zip.File
}

func Open(zipPath string) (*Index, error) {
	archive, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, err
	}

	files := make(map[string]*zip.File)
	ambiguous := make(map[string]struct{})
	for _, file := range archive.File {
		if file.FileInfo().IsDir() || !strings.EqualFold(path.Ext(file.Name), ".mp3") {
			continue
		}
		key := strings.TrimSuffix(path.Base(file.Name), path.Ext(file.Name))
		if key == "" || strings.HasPrefix(file.Name, "__MACOSX/") {
			continue
		}
		if _, exists := files[key]; exists {
			delete(files, key)
			ambiguous[key] = struct{}{}
			continue
		}
		if _, exists := ambiguous[key]; !exists {
			files[key] = file
		}
	}
	return &Index{archive: archive, files: files}, nil
}

func (i *Index) Open(key string) (io.ReadCloser, int64, error) {
	if key == "" || strings.ContainsAny(key, "/\\") || key == "." || key == ".." {
		return nil, 0, ErrNotFound
	}
	file, ok := i.files[key]
	if !ok {
		return nil, 0, ErrNotFound
	}
	reader, err := file.Open()
	if err != nil {
		return nil, 0, err
	}
	return reader, int64(file.UncompressedSize64), nil
}

func (i *Index) Close() error {
	if i == nil || i.archive == nil {
		return nil
	}
	return i.archive.Close()
}
