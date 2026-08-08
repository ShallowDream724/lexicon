//go:build windows

package reversesearch

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func replaceAtomically(temporaryPath, targetPath string, replace bool) error {
	if !replace {
		if _, err := os.Stat(targetPath); err == nil {
			return fmt.Errorf("target database already exists: %s", targetPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	flags := uint32(windows.MOVEFILE_WRITE_THROUGH)
	if replace {
		flags |= windows.MOVEFILE_REPLACE_EXISTING
	}
	return windows.MoveFileEx(windows.StringToUTF16Ptr(temporaryPath), windows.StringToUTF16Ptr(targetPath), flags)
}
