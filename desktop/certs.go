package main

// Security certificates so the iPhone can talk to this computer privately over Wi-Fi.
// A small "certificate authority" is created once and installed on the phone.
// The server certificate is re-made at every start for the computer's current Wi-Fi address.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

type certs struct {
	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
	caDER  []byte
}

func randSerial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	return n
}

func loadOrCreateCA(dir string) (*certs, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	crtPath, keyPath := filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key")
	if crtPEM, err := os.ReadFile(crtPath); err == nil {
		if keyPEM, err := os.ReadFile(keyPath); err == nil {
			cb, _ := pem.Decode(crtPEM)
			kb, _ := pem.Decode(keyPEM)
			if cb != nil && kb != nil {
				c, err1 := x509.ParseCertificate(cb.Bytes)
				k, err2 := x509.ParseECPrivateKey(kb.Bytes)
				if err1 == nil && err2 == nil && time.Now().Before(c.NotAfter.Add(-30*24*time.Hour)) {
					return &certs{c, k, cb.Bytes}, nil
				}
			}
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	tpl := &x509.Certificate{
		SerialNumber:          randSerial(),
		Subject:               pkix.Name{CommonName: "KellerKraft Receipts (" + host + ")", Organization: []string{"KellerKraft Receipts"}},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	kd, _ := x509.MarshalECPrivateKey(key)
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd}), 0600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(crtPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644); err != nil {
		return nil, err
	}
	c, _ := x509.ParseCertificate(der)
	return &certs{c, key, der}, nil
}

// Server certificate for this computer's current addresses (valid < 825 days, as iPhones require)
func (c *certs) serverCert(ips []net.IP) (tls.Certificate, error) {
	if c == nil {
		return tls.Certificate{}, errors.New("no CA")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	host, _ := os.Hostname()
	all := append([]net.IP{net.ParseIP("127.0.0.1")}, ips...)
	tpl := &x509.Certificate{
		SerialNumber: randSerial(),
		Subject:      pkix.Name{CommonName: "KellerKraft Receipts", Organization: []string{"KellerKraft Receipts"}},
		NotBefore:    time.Now().Add(-24 * time.Hour),
		NotAfter:     time.Now().AddDate(0, 0, 390),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", host, host + ".local"},
		IPAddresses:  all,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.caCert, &key.PublicKey, c.caKey)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der, c.caDER}, PrivateKey: key}, nil
}

// This computer's Wi-Fi / network addresses (private IPv4 only)
func lanIPs() []net.IP {
	var out []net.IP
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip4 := ip.To4(); ip4 != nil && ip4.IsPrivate() {
				out = append(out, ip4)
			}
		}
	}
	return out
}
