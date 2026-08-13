package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/dagu"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/platform/httpserver"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}

	var serverOptions []httpserver.Option
	if endpoint := cfg.Endpoints[config.CapabilityPlaybook]; endpoint != "" {
		var tokenSource dagu.TokenSource
		if cfg.DaguTokenFile != "" {
			tokenSource = func() (string, error) {
				content, err := os.ReadFile(cfg.DaguTokenFile)
				return string(content), err
			}
		}
		client, err := dagu.NewClient(endpoint, &http.Client{Timeout: 45 * time.Second}, dagu.WithTokenSource(tokenSource))
		if err != nil {
			logger.Error("configure Dagu client", "error", err)
			os.Exit(1)
		}
		provider, err := dagu.NewProvider(client)
		if err != nil {
			logger.Error("configure Dagu provider", "error", err)
			os.Exit(1)
		}
		serverOptions = append(serverOptions, httpserver.WithPlaybookProvider(provider))
	}
	server := httpserver.New(cfg, logger, serverOptions...)
	runCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("control plane listening", "address", cfg.HTTPAddress)
		errCh <- server.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("control plane stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	case <-runCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("control plane shutdown failed", "error", err)
			os.Exit(1)
		}
	}
}
