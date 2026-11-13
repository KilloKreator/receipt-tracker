//go:build windows

package main

// Windows network check & fix: the phone can only reach this program if
//  • the home network is "Private" in Windows, and
//  • Windows Firewall lets KellerKraft Receipts receive connections.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func powershell(script string) (string, error) {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

type netStatus struct {
	Supported   bool       `json:"supported"`
	Networks    []netEntry `json:"networks"`
	PublicCount int        `json:"publicCount"`
	AllowRule   bool       `json:"allowRule"`
	BlockRules  int        `json:"blockRules"`
	OK          bool       `json:"ok"`
	Error       string     `json:"error,omitempty"`
}
type netEntry struct {
	Name     string `json:"name"`
	Adapter  string `json:"adapter"`
	Category string `json:"category"`
}

func netCheck() netStatus {
	st := netStatus{Supported: true}
	out, err := powershell(`Get-NetConnectionProfile | ForEach-Object { $_.Name + '|' + $_.InterfaceAlias + '|' + $_.NetworkCategory }`)
	if err != nil {
		st.Error = out
	}
	for _, ln := range strings.Split(out, "\n") {
		p := strings.Split(strings.TrimSpace(ln), "|")
		if len(p) == 3 {
			st.Networks = append(st.Networks, netEntry{p[0], p[1], p[2]})
			if p[2] == "Public" {
				st.PublicCount++
			}
		}
	}
	exe, _ := os.Executable()
	o2, _ := powershell(`@(Get-NetFirewallRule -DisplayName 'KellerKraft Receipts' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' }).Count`)
	st.AllowRule = strings.TrimSpace(o2) != "" && strings.TrimSpace(o2) != "0"
	o3, _ := powershell(`@(Get-NetFirewallApplicationFilter -Program ` + psQuote(exe) + ` -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }).Count`)
	fmt.Sscan(strings.TrimSpace(o3), &st.BlockRules)
	st.OK = st.PublicCount == 0 && st.AllowRule && st.BlockRules == 0
	return st
}

// Runs the fix as administrator (Windows asks "Do you want to allow this app to make changes?")
func netFix() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	result := filepath.Join(dataDir, "network-fix-result.txt")
	os.Remove(result)
	script := filepath.Join(dataDir, "network-fix.ps1")
	ps := `$ErrorActionPreference = 'Continue'
try {
  # 1. Home network: Public -> Private (only networks connected right now)
  Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | Set-NetConnectionProfile -NetworkCategory Private
  # 2. Remove "block" rules Windows made if the firewall question was cancelled
  Get-NetFirewallApplicationFilter -Program ` + psQuote(exe) + ` -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule
  # 3. Allow KellerKraft Receipts (ports 8780 and 8443) on private networks
  Remove-NetFirewallRule -DisplayName 'KellerKraft Receipts' -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'KellerKraft Receipts' -Direction Inbound -Action Allow -Program ` + psQuote(exe) + ` -Profile Private,Domain | Out-Null
  New-NetFirewallRule -DisplayName 'KellerKraft Receipts' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8780,8443 -Profile Private,Domain | Out-Null
  'ok' | Out-File -Encoding ascii ` + psQuote(result) + `
} catch {
  $_.ToString() | Out-File -Encoding ascii ` + psQuote(result) + `
}
`
	if err := os.WriteFile(script, []byte(ps), 0644); err != nil {
		return err
	}
	_, err = powershell(`Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"` + strings.ReplaceAll(script, "'", "''") + `"')`)
	if err != nil {
		return errors.New("Windows did not allow the change (was \"Yes\" clicked?)")
	}
	time.Sleep(300 * time.Millisecond)
	b, _ := os.ReadFile(result)
	res := strings.TrimSpace(string(b))
	if res == "" {
		return errors.New("Windows did not allow the change (was \"Yes\" clicked?)")
	}
	if res != "ok" {
		return errors.New(res)
	}
	return nil
}
