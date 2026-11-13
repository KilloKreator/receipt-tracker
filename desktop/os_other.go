//go:build !windows

package main

import "os/exec"

// Start-with-Windows only exists on Windows; these let the program run elsewhere for testing.
var fakeAutostart bool

func hideWindow(cmd *exec.Cmd)       {}
func autostartEnabled() bool         { return fakeAutostart }
func setAutostart(on bool) error     { fakeAutostart = on; return nil }
func showError(msg string)           {}
