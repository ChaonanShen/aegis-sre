package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

const maxJSONLMessageBytes = 8 << 20

type wireMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *wireError      `json:"error,omitempty"`
}

type wireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Notification struct {
	Method string
	Params json.RawMessage
}

type response struct {
	result json.RawMessage
	err    error
}

type Client struct {
	input         io.WriteCloser
	output        io.ReadCloser
	writeMu       sync.Mutex
	pendingMu     sync.Mutex
	pending       map[int64]chan response
	notifications chan Notification
	done          chan struct{}
	closeOnce     sync.Once
	terminalErr   error
	sequence      atomic.Int64
}

func NewClient(input io.WriteCloser, output io.ReadCloser) (*Client, error) {
	if input == nil || output == nil {
		return nil, errors.New("Codex stdin and stdout are required")
	}
	client := &Client{
		input: input, output: output, pending: make(map[int64]chan response),
		notifications: make(chan Notification, 128), done: make(chan struct{}),
	}
	go client.readLoop()
	return client, nil
}

func (client *Client) Initialize(ctx context.Context) error {
	var result struct{}
	if err := client.Call(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "aegis-sre", "title": "Aegis SRE", "version": "1.0.0"},
		"capabilities": map[string]any{"experimentalApi": false},
	}, &result); err != nil {
		return fmt.Errorf("initialize Codex App Server: %w", err)
	}
	return client.Notify("initialized", map[string]any{})
}

func (client *Client) Call(ctx context.Context, method string, params, target any) error {
	if method == "" {
		return errors.New("Codex method is required")
	}
	id := client.sequence.Add(1)
	result := make(chan response, 1)
	client.pendingMu.Lock()
	client.pending[id] = result
	client.pendingMu.Unlock()
	if err := client.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		client.removePending(id)
		return err
	}
	select {
	case <-ctx.Done():
		client.removePending(id)
		return ctx.Err()
	case item := <-result:
		if item.err != nil {
			return item.err
		}
		if target == nil {
			return nil
		}
		if err := json.Unmarshal(item.result, target); err != nil {
			return errors.New("decode Codex response")
		}
		return nil
	}
}

func (client *Client) Notify(method string, params any) error {
	return client.write(map[string]any{"method": method, "params": params})
}

func (client *Client) Notifications() <-chan Notification { return client.notifications }
func (client *Client) Done() <-chan struct{}              { return client.done }

func (client *Client) Close() error {
	client.closeWithError(io.EOF)
	return nil
}

func (client *Client) write(value any) error {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	select {
	case <-client.done:
		return errors.New("Codex App Server is closed")
	default:
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return errors.New("encode Codex request")
	}
	encoded = append(encoded, '\n')
	if _, err := client.input.Write(encoded); err != nil {
		return fmt.Errorf("write Codex request: %w", err)
	}
	return nil
}

func (client *Client) readLoop() {
	scanner := bufio.NewScanner(client.output)
	scanner.Buffer(make([]byte, 64<<10), maxJSONLMessageBytes)
	for scanner.Scan() {
		var message wireMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			client.closeWithError(errors.New("decode Codex JSONL message"))
			return
		}
		if len(message.ID) > 0 {
			var id int64
			if json.Unmarshal(message.ID, &id) == nil {
				client.deliver(id, message)
			}
			continue
		}
		if message.Method != "" {
			select {
			case client.notifications <- Notification{Method: message.Method, Params: message.Params}:
			case <-client.done:
				return
			}
		}
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	client.closeWithError(fmt.Errorf("Codex App Server stream ended: %w", err))
}

func (client *Client) deliver(id int64, message wireMessage) {
	client.pendingMu.Lock()
	channel := client.pending[id]
	delete(client.pending, id)
	client.pendingMu.Unlock()
	if channel == nil {
		return
	}
	if message.Error != nil {
		channel <- response{err: fmt.Errorf("Codex RPC error %d", message.Error.Code)}
		return
	}
	channel <- response{result: message.Result}
}

func (client *Client) removePending(id int64) {
	client.pendingMu.Lock()
	delete(client.pending, id)
	client.pendingMu.Unlock()
}

func (client *Client) closeWithError(err error) {
	client.closeOnce.Do(func() {
		client.terminalErr = err
		_ = client.input.Close()
		_ = client.output.Close()
		client.pendingMu.Lock()
		for id, channel := range client.pending {
			channel <- response{err: err}
			delete(client.pending, id)
		}
		client.pendingMu.Unlock()
		close(client.done)
		close(client.notifications)
	})
}
