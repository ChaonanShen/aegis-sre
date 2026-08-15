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
	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgefactory"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/adapters/opencode"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/platform/httpserver"
	"github.com/1024XEngineer/aegis-sre/internal/platform/knowledgemcp"
	"github.com/1024XEngineer/aegis-sre/internal/platform/playbookmcp"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
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
	if cfg.AgentProvider != "" {
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
		var agentProvider ports.AgentProvider
		if cfg.AgentProvider == "codex" {
			codexProcess, err = codex.StartProcess(runCtx, cfg.CodexInitTimeout, codex.ProcessConfig{Command: cfg.CodexCommand, Args: []string{"app-server"}, Dir: cfg.AgentWorkDir})
			if err != nil {
				return err
			}
			defer codexProcess.Close()
			provider, err := codex.NewProvider(codexProcess.Client(), codec, cfg.AgentWorkDir)
			if err != nil {
				return err
			}
			agentProvider = provider
		} else {
			transport := http.DefaultTransport.(*http.Transport).Clone()
			transport.ResponseHeaderTimeout = 15 * time.Second
			client, err := opencode.NewClient(cfg.Endpoints[config.CapabilityAgent], &http.Client{Transport: transport}, cfg.OpenCodeUsername, func() (string, error) {
				content, err := os.ReadFile(cfg.OpenCodePasswordFile)
				return string(content), err
			})
			if err != nil {
				return err
			}
			provider, err := opencode.NewProvider(client, codec)
			if err != nil {
				return err
			}
			agentProvider = provider
		}
		scoped, err := agentscope.New(agentProvider, agentscope.Scope{TenantID: cfg.AgentTenantID, OrgID: cfg.AgentOrgID, UserID: cfg.AgentUserID})
		if err != nil {
			return err
		}
		serverOptions = append(serverOptions, httpserver.WithAgentProvider(scoped))
	}
	var playbookProvider ports.PlaybookProvider
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
		playbookProvider = provider
		serverOptions = append(serverOptions, httpserver.WithPlaybookProvider(provider))
	}
	if playbookProvider != nil && cfg.PlaybookMCPTokenFile != "" {
		handler, err := playbookmcp.NewHandler(playbookProvider, playbookmcp.Config{
			TokenFile: cfg.PlaybookMCPTokenFile, TenantID: cfg.AgentTenantID, OrgID: cfg.AgentOrgID,
			UserID: cfg.AgentUserID, FolderUIDs: cfg.PlaybookMCPFolders,
		})
		if err != nil {
			return err
		}
		serverOptions = append(serverOptions, httpserver.WithPlaybookMCP(handler))
	}
	if endpoint := cfg.Endpoints[config.CapabilityKnowledge]; endpoint != "" {
		keyContent, err := os.ReadFile(cfg.KnowledgeIDKeyFile)
		if err != nil {
			return errors.New("read knowledge ID key")
		}
		key, err := knowledgeid.DecodeKey(keyContent)
		if err != nil {
			return err
		}
		ids, err := knowledgeid.New(key)
		if err != nil {
			return err
		}
		provider, err := knowledgefactory.New(cfg, ids)
		if err != nil {
			return err
		}
		serverOptions = append(serverOptions, httpserver.WithKnowledgeProvider(provider, ids))
		if cfg.KnowledgeMCPTokenFile != "" {
			handler, err := knowledgemcp.NewHandler(provider, knowledgemcp.Config{
				TokenFile: cfg.KnowledgeMCPTokenFile, TenantID: cfg.KnowledgeMCPTenantID, OrgID: cfg.KnowledgeMCPOrgID,
				UserID: cfg.KnowledgeMCPUserID, FolderUIDs: cfg.KnowledgeMCPFolders,
			})
			if err != nil {
				return err
			}
			serverOptions = append(serverOptions, httpserver.WithKnowledgeMCP(handler))
		}
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
