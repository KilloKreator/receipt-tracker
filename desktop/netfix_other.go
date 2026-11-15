package main

// The program no longer changes Windows network or firewall settings itself
// (that looks like malware to virus scanners). Phone setup explains the steps instead.

type netStatus struct {
	Supported bool `json:"supported"`
	OK        bool `json:"ok"`
}

func netCheck() netStatus { return netStatus{Supported: false, OK: true} }
func netFix() error       { return nil }
