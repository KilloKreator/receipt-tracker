//go:build !windows

package main

type netStatus struct {
	Supported bool `json:"supported"`
	OK        bool `json:"ok"`
}

func netCheck() netStatus { return netStatus{Supported: false, OK: true} }
func netFix() error       { return nil }
