package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"
)

const defaultStopTimeout = 5 * time.Second

type ProcessConfig struct {
	Command string
	Args    []string
	Dir     string
	Env     []string
}

// Process 监管单个长期运行的 Codex App Server；会话状态仍完全由 Codex 数据目录持有。
type Process struct {
	command   *exec.Cmd
	client    *Client
	done      chan struct{}
	waitMu    sync.Mutex
	waitErr   error
	closeOnce sync.Once
}

func StartProcess(lifetime context.Context, initializeTimeout time.Duration, cfg ProcessConfig) (*Process, error) {
	if lifetime == nil {
		return nil, errors.New("Codex process lifetime context is required")
	}
	if cfg.Command == "" {
		return nil, errors.New("Codex command is required")
	}
	if initializeTimeout <= 0 {
		return nil, errors.New("Codex initialize timeout must be positive")
	}
	command := exec.CommandContext(lifetime, cfg.Command, cfg.Args...)
	command.Dir = cfg.Dir
	command.Env = append(os.Environ(), cfg.Env...)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, errors.New("open Codex stdin")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, errors.New("open Codex stdout")
	}
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start Codex App Server: %w", err)
	}
	client, err := NewClient(stdin, stdout)
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, err
	}
	process := &Process{command: command, client: client, done: make(chan struct{})}
	go process.wait()

	initializeCtx, cancel := context.WithTimeout(lifetime, initializeTimeout)
	defer cancel()
	if err := client.Initialize(initializeCtx); err != nil {
		_ = process.Close()
		return nil, err
	}
	return process, nil
}

func (process *Process) Client() *Client       { return process.client }
func (process *Process) Done() <-chan struct{} { return process.done }

func (process *Process) Check(context.Context) error {
	select {
	case <-process.done:
		process.waitMu.Lock()
		defer process.waitMu.Unlock()
		if process.waitErr != nil {
			return fmt.Errorf("Codex App Server exited: %w", process.waitErr)
		}
		return errors.New("Codex App Server exited")
	default:
		return nil
	}
}

func (process *Process) Close() error {
	process.closeOnce.Do(func() {
		_ = process.client.Close()
		select {
		case <-process.done:
			return
		case <-time.After(defaultStopTimeout):
		}
		if process.command.Process != nil {
			_ = process.command.Process.Kill()
		}
		<-process.done
	})
	return nil
}

func (process *Process) wait() {
	err := process.command.Wait()
	process.waitMu.Lock()
	process.waitErr = err
	process.waitMu.Unlock()
	process.client.closeWithError(errors.New("Codex App Server process exited"))
	close(process.done)
}
