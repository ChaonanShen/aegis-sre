package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/agentid"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/agentscope"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/codex"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/dagu"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/platform/httpserver"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("control plane stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	runCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var serverOptions []httpserver.Option
	var codexProcess *codex.Process
	if cfg.AgentProvider == "codex" {
		keyContent, err := os.ReadFile(cfg.AgentIDKeyFile)
		if err != nil {
			return errors.New("read agent ID key")
		}
		key, err := agentid.DecodeKey(keyContent)
		if err != nil {
			return err
		}
		codec, err := agentid.New(key)
		if err != nil {
			return err
		}
		codexProcess, err = codex.StartProcess(runCtx, cfg.CodexInitTimeout, codex.ProcessConfig{Command: cfg.CodexCommand, Args: []string{"app-server"}, Dir: cfg.AgentWorkDir})
		if err != nil {
			return err
		}
		defer codexProcess.Close()
		provider, err := codex.NewProvider(codexProcess.Client(), codec, cfg.AgentWorkDir)
		if err != nil {
			return err
		}
		scoped, err := agentscope.New(provider, agentscope.Scope{TenantID: cfg.AgentTenantID, OrgID: cfg.AgentOrgID, UserID: cfg.AgentUserID})
		if err != nil {
			return err
		}
		serverOptions = append(serverOptions, httpserver.WithAgentProvider(scoped))
	} else if cfg.AgentProvider != "" {
		return errors.New("configured agent provider is not connected")
	}
	if endpoint := cfg.Endpoints[config.CapabilityPlaybook]; endpoint != "" {
		var tokenSource dagu.TokenSource
		var basicAuthSource dagu.BasicAuthSource
		if cfg.DaguTokenFile != "" {
			tokenSource = func() (string, error) {
				content, err := os.ReadFile(cfg.DaguTokenFile)
				return string(content), err
			}
		}
		if cfg.DaguBasicPass != "" {
			basicAuthSource = func() (string, string, error) {
				content, err := os.ReadFile(cfg.DaguBasicPass)
				return cfg.DaguBasicUser, strings.TrimSpace(string(content)), err
			}
		}
		client, err := dagu.NewClient(endpoint, &http.Client{Timeout: 45 * time.Second}, dagu.WithTokenSource(tokenSource), dagu.WithBasicAuthSource(basicAuthSource))
		if err != nil {
			return err
		}
		provider, err := dagu.NewProvider(client)
		if err != nil {
			return err
		}
		serverOptions = append(serverOptions, httpserver.WithPlaybookProvider(provider))
	}
	server := httpserver.New(cfg, logger, serverOptions...)

	errCh := make(chan error, 1)
	go func() {
		logger.Info("control plane listening", "address", cfg.HTTPAddress)
		errCh <- server.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-runCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
	}
	return nil
}
