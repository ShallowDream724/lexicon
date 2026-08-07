//go:build !windows

package etymology

import (
	"errors"
	"fmt"
	"os"
)

func replaceAtomically(temporaryPath, targetPath string, replace bool) error {
	if !replace {
		if _, err := os.Stat(targetPath); err == nil {
			return fmt.Errorf("target database already exists: %s (use -replace to overwrite)", targetPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Rename(temporaryPath, targetPath)
}
