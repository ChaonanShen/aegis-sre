package codex

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type pipeProcess struct {
	clientInput  *io.PipeWriter
	clientOutput *io.PipeReader
	serverInput  *io.PipeReader
	serverOutput *io.PipeWriter
}

func newPipeProcess() *pipeProcess {
	serverInput, clientInput := io.Pipe()
	clientOutput, serverOutput := io.Pipe()
	return &pipeProcess{clientInput: clientInput, clientOutput: clientOutput, serverInput: serverInput, serverOutput: serverOutput}
}

func TestClientInitializesCorrelatesConcurrentCallsAndReceivesNotifications(t *testing.T) {
	t.Parallel()
	process := newPipeProcess()
	client, _ := NewClient(process.clientInput, process.clientOutput)
	defer client.Close()
	go func() {
		decoder := json.NewDecoder(process.serverInput)
		for count := 0; count < 4; count++ {
			var request map[string]any
			if decoder.Decode(&request) != nil {
				return
			}
			method, _ := request["method"].(string)
			if method == "initialized" {
				continue
			}
			id := request["id"]
			if method == "initialize" {
				_, _ = process.serverOutput.Write([]byte(`{"id":` + number(id) + `,"result":{}}` + "\n"))
				_, _ = process.serverOutput.Write([]byte(`{"method":"thread/started","params":{"thread":{"id":"uuid"}}}` + "\n"))
				continue
			}
			// Deliberately return responses in independent goroutines.
			go func() {
				_, _ = process.serverOutput.Write([]byte(`{"id":` + number(id) + `,"result":{"method":"` + method + `"}}` + "\n"))
			}()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case item := <-client.Notifications():
		if item.Method != "thread/started" {
			t.Fatalf("notification = %#v", item)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var wg sync.WaitGroup
	for _, method := range []string{"thread/read", "thread/list"} {
		wg.Add(1)
		go func(method string) {
			defer wg.Done()
			var output map[string]string
			if err := client.Call(ctx, method, map[string]any{}, &output); err != nil || output["method"] != method {
				t.Errorf("method = %q, output = %#v, err = %v", method, output, err)
			}
		}(method)
	}
	wg.Wait()
}

func TestClientSanitizesRPCErrorAndUnblocksOnExit(t *testing.T) {
	t.Parallel()
	process := newPipeProcess()
	client, _ := NewClient(process.clientInput, process.clientOutput)
	go func() {
		var request map[string]any
		_ = json.NewDecoder(process.serverInput).Decode(&request)
		_, _ = process.serverOutput.Write([]byte(`{"id":1,"error":{"code":-32000,"message":"provider secret"}}` + "\n"))
	}()
	err := client.Call(context.Background(), "thread/read", nil, nil)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %v", err)
	}

	exited := newPipeProcess()
	exitClient, _ := NewClient(exited.clientInput, exited.clientOutput)
	go func() { _ = exited.serverOutput.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := exitClient.Call(ctx, "thread/read", nil, nil); err == nil {
		t.Fatal("process exit must fail pending call")
	}
}

func TestClientReceivesAndRepliesToServerRequests(t *testing.T) {
	t.Parallel()
	process := newPipeProcess()
	client, _ := NewClient(process.clientInput, process.clientOutput)
	defer client.Close()
	serverReply := make(chan map[string]any, 1)
	go func() {
		_, _ = process.serverOutput.Write([]byte(`{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}}` + "\n"))
		var reply map[string]any
		_ = json.NewDecoder(process.serverInput).Decode(&reply)
		serverReply <- reply
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	select {
	case request := <-client.Requests():
		if request.Method != "item/commandExecution/requestApproval" || string(request.ID) != `"approval-1"` {
			t.Fatalf("request = %#v", request)
		}
		if err := client.Reply(request, map[string]string{"decision": "accept"}); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case reply := <-serverReply:
		if reply["id"] != "approval-1" || reply["method"] != nil {
			t.Fatalf("reply = %#v", reply)
		}
		result, _ := reply["result"].(map[string]any)
		if result["decision"] != "accept" {
			t.Fatalf("result = %#v", result)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestClientRejectsInvalidReplyID(t *testing.T) {
	t.Parallel()
	process := newPipeProcess()
	client, _ := NewClient(process.clientInput, process.clientOutput)
	defer client.Close()
	if err := client.Reply(Request{ID: json.RawMessage(`not-json`)}, map[string]any{}); err == nil {
		t.Fatal("invalid server request ID must be rejected")
	}
}

func TestClientRepliesWithProtocolError(t *testing.T) {
	t.Parallel()
	process := newPipeProcess()
	client, _ := NewClient(process.clientInput, process.clientOutput)
	defer client.Close()
	reply := make(chan map[string]any, 1)
	go func() {
		var message map[string]any
		_ = json.NewDecoder(process.serverInput).Decode(&message)
		reply <- message
	}()
	if err := client.ReplyError(Request{ID: json.RawMessage(`7`)}, -32601, "unsupported request"); err != nil {
		t.Fatal(err)
	}
	message := <-reply
	errorValue, _ := message["error"].(map[string]any)
	if message["id"] != float64(7) || errorValue["code"] != float64(-32601) || errorValue["message"] != "unsupported request" {
		t.Fatalf("reply = %#v", message)
	}
}

func TestClientDoneClosesWhenExplicitlyStopped(t *testing.T) {
	t.Parallel()
	process := newPipeProcess()
	client, _ := NewClient(process.clientInput, process.clientOutput)
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("Done was not closed")
	}
}

func number(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
