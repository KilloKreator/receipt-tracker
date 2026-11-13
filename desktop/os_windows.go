//go:build windows

package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

const runKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
const runName = "KellerKraft Receipts"

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

func autostartEnabled() bool {
	cmd := exec.Command("reg", "query", runKey, "/v", runName)
	hideWindow(cmd)
	out, err := cmd.Output()
	return err == nil && strings.Contains(string(out), runName)
}

func setAutostart(on bool) error {
	var cmd *exec.Cmd
	if on {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		cmd = exec.Command("reg", "add", runKey, "/v", runName, "/t", "REG_SZ", "/d", `"`+exe+`"`, "/f")
	} else {
		cmd = exec.Command("reg", "delete", runKey, "/v", runName, "/f")
	}
	hideWindow(cmd)
	return cmd.Run()
}

func showError(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString("KellerKraft Receipts")
	m, _ := syscall.UTF16PtrFromString(msg)
	box.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}
