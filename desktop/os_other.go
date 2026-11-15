//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

func hideWindow(cmd *exec.Cmd) {}
func autostartEnabled() bool   { return false }
func openStartupFolder()       {}
func showError(msg string)     {}

func shellOpen(target string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	exec.Command(name, target).Start()
}
