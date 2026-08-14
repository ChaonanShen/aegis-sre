package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProcessStartsInitializesChecksAndStops(t *testing.T) {
	t.Parallel()
	lifetime, cancel := context.WithCancel(context.Background())
	defer cancel()
	process, err := StartProcess(lifetime, time.Second, helperProcessConfig("serve"))
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Check(context.Background()); err != nil {
		t.Fatalf("healthy process: %v", err)
	}
	if process.Client() == nil {
		t.Fatal("client is nil")
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.Done():
	case <-time.After(time.Second):
		t.Fatal("process did not stop")
	}
	if err := process.Check(context.Background()); err == nil {
		t.Fatal("stopped process reported healthy")
	}
}

func TestProcessFailsClosedWhenHandshakeDoesNotComplete(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := StartProcess(ctx, time.Second, helperProcessConfig("exit")); err == nil {
		t.Fatal("early process exit must fail startup")
	}
}

func TestProcessConfigurationValidation(t *testing.T) {
	t.Parallel()
	if _, err := StartProcess(nil, time.Second, ProcessConfig{Command: "codex"}); err == nil {
		t.Fatal("nil lifetime must be rejected")
	}
	if _, err := StartProcess(context.Background(), time.Second, ProcessConfig{}); err == nil {
		t.Fatal("empty command must be rejected")
	}
	if _, err := StartProcess(context.Background(), 0, ProcessConfig{Command: "codex"}); err == nil {
		t.Fatal("non-positive initialize timeout must be rejected")
	}
}

func helperProcessConfig(mode string) ProcessConfig {
	return ProcessConfig{Command: os.Args[0], Args: []string{"-test.run=TestCodexProcessHelper", "--", mode}, Env: []string{"AEGIS_CODEX_HELPER=1"}}
}

func TestCodexProcessHelper(t *testing.T) {
	if os.Getenv("AEGIS_CODEX_HELPER") != "1" {
		return
	}
	mode := ""
	for index, arg := range os.Args {
		if arg == "--" && index+1 < len(os.Args) {
			mode = os.Args[index+1]
		}
	}
	if mode == "exit" {
		os.Exit(0)
	}
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		os.Exit(2)
	}
	var request map[string]any
	if json.Unmarshal([]byte(line), &request) != nil || request["method"] != "initialize" {
		os.Exit(3)
	}
	response := `{"id":` + number(request["id"]) + `,"result":{"codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux","userAgent":"Codex CLI/` + PinnedVersion + ` (test)"}}` + "\n"
	_, _ = os.Stdout.WriteString(response)
	initialized, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(initialized, `"method":"initialized"`) {
		os.Exit(4)
	}
	_, _ = reader.ReadString('\n')
	os.Exit(0)
}
