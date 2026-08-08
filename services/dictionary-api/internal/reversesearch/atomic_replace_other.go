//go:build !windows

package reversesearch

import (
	"errors"
	"fmt"
	"os"
)

func replaceAtomically(temporaryPath, targetPath string, replace bool) error {
	if !replace {
		if _, err := os.Stat(targetPath); err == nil {
			return fmt.Errorf("target database already exists: %s", targetPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Rename(temporaryPath, targetPath)
}
