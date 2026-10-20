// Command lish-overlay runs one LiberShare protected network: a Nebula node in user space (gVisor netstack, no
// TUN adapter, no administrator rights) bridged to the backend over loopback TCP. It also holds the key and
// certificate commands, so the cryptography stays inside the Nebula library.
//
//	lish-overlay run --config nebula.yml --port 9090        (token in LISH_OVERLAY_TOKEN)
//	lish-overlay ca --name N --network 100.64.0.0/16 --out-crt ca.crt --out-key ca.key
//	lish-overlay keygen --out-key member.key
//	lish-overlay sign --ca-crt ca.crt --ca-key ca.key --public-key member.pub --name N --ip 100.64.0.2/16 --out-crt member.crt
//	lish-overlay print --crt member.crt
//
// Every command except run prints exactly one JSON object on stdout.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fail(fmt.Errorf("usage: lish-overlay run|ca|keygen|sign|print|version [flags]"))
	}
	var out any
	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "run":
		err = cmdRun(args)
	case "ca":
		out, err = cmdCA(args)
	case "keygen":
		out, err = cmdKeygen(args)
	case "sign":
		out, err = cmdSign(args)
	case "print":
		out, err = cmdPrint(args)
	case "version":
		out = map[string]string{"version": version}
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fail(err)
	}
	if out != nil {
		if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
			fail(err)
		}
	}
}

// required reports the first of names that was not given on the command line.
func required(fs *flag.FlagSet, names ...string) error {
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	for _, n := range names {
		if !set[n] {
			return fmt.Errorf("-%s is required", n)
		}
	}
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "lish-overlay:", err)
	os.Exit(1)
}
