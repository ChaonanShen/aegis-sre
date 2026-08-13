package plugin

import (
	"context"
	"net/http"
	"os"

	"github.com/1024XEngineer/Torchbearing/api/analysis"
	"github.com/1024XEngineer/Torchbearing/api/client"
	pluginconfig "github.com/1024XEngineer/Torchbearing/grafana-plugin-app/pkg/plugin/config"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// Make sure App implements required interfaces. This is important to do
// since otherwise we will only get a not implemented error response from plugin in
// runtime. Plugin should not implement all these interfaces - only those which are
// required for a particular task.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is the plugin backend application.
type App struct {
	backend.CallResourceHandler
	aiCore    *client.Client
	aiModelID analysis.ModelID
}

// NewApp creates a new *App instance.
func NewApp(_ context.Context, _ backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	runtime, err := pluginconfig.LoadRuntime(os.Getenv)
	if err != nil {
		return nil, err
	}
	app := &App{
		aiCore:    client.New(runtime.AICoreURL, ""),
		aiModelID: analysis.ModelID(runtime.AIModelID),
	}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)
	return app, nil
}

// Dispose here tells plugin SDK that plugin wants to clean up resources when a new instance
// created.
func (a *App) Dispose() {
	// cleanup
}

// CheckHealth handles health checks sent from Grafana to the plugin.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "ok",
	}, nil
}
