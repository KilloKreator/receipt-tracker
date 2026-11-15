//go:build windows

package main

// Windows helpers, using only the normal Windows functions every program uses
// (no PowerShell, no registry tools, no firewall changes).

import (
	"os/exec"
	"syscall"
	"unsafe"
)

var (
	shell32      = syscall.NewLazyDLL("shell32.dll")
	shellExecute = shell32.NewProc("ShellExecuteW")
	user32       = syscall.NewLazyDLL("user32.dll")
	messageBox   = user32.NewProc("MessageBoxW")
)

// Open a web address or folder the normal way (like double-clicking it)
func shellOpen(target string) {
	verb, _ := syscall.UTF16PtrFromString("open")
	t, _ := syscall.UTF16PtrFromString(target)
	shellExecute.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(t)), 0, 0, 1)
}

func hideWindow(cmd *exec.Cmd) {}

func showError(msg string) {
	t, _ := syscall.UTF16PtrFromString("KellerKraft Time Saver")
	m, _ := syscall.UTF16PtrFromString(msg)
	messageBox.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}
