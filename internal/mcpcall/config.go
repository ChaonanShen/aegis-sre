package mcpcall

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Servers map[string]ServerConfig `yaml:"servers"`
}

type ServerConfig struct {
	URL              string        `yaml:"url"`
	AllowedTools     []string      `yaml:"allowed_tools"`
	WriteTools       []string      `yaml:"write_tools,omitempty"`
	AllowWrite       bool          `yaml:"allow_write,omitempty"`
	BearerTokenFile  string        `yaml:"bearer_token_file,omitempty"`
	CAFile           string        `yaml:"ca_file,omitempty"`
	ClientCertFile   string        `yaml:"client_cert_file,omitempty"`
	ClientKeyFile    string        `yaml:"client_key_file,omitempty"`
	ConnectTimeout   time.Duration `yaml:"connect_timeout,omitempty"`
	HandshakeTimeout time.Duration `yaml:"handshake_timeout,omitempty"`
	CallTimeout      time.Duration `yaml:"call_timeout,omitempty"`
	TotalTimeout     time.Duration `yaml:"total_timeout,omitempty"`
	MaxTextBytes     int64         `yaml:"max_text_bytes,omitempty"`
	MaxStructured    int64         `yaml:"max_structured_bytes,omitempty"`
	MaxBinaryBytes   int64         `yaml:"max_binary_bytes,omitempty"`
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read MCP policy: %w", err)
	}
	var config Config
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("parse MCP policy: %w", err)
	}
	if len(config.Servers) == 0 {
		return nil, errors.New("MCP policy contains no servers")
	}
	for name, server := range config.Servers {
		server.withDefaults()
		if err := server.validate(name); err != nil {
			return nil, err
		}
		config.Servers[name] = server
	}
	return &config, nil
}

func (config *Config) Resolve(serverName, tool string) (ServerConfig, error) {
	server, ok := config.Servers[serverName]
	if !ok {
		return ServerConfig{}, fmt.Errorf("MCP server %q is not allowed", serverName)
	}
	if slices.Contains(server.WriteTools, tool) {
		if !server.AllowWrite {
			return ServerConfig{}, fmt.Errorf("MCP write tool %q is disabled on server %q", tool, serverName)
		}
	} else if !slices.Contains(server.AllowedTools, tool) {
		return ServerConfig{}, fmt.Errorf("MCP tool %q is not allowed on server %q", tool, serverName)
	}
	if recursiveDaguCall(serverName, tool) {
		return ServerConfig{}, fmt.Errorf("recursive Dagu execution tool %q is forbidden", tool)
	}
	return server, nil
}

func (server *ServerConfig) withDefaults() {
	if server.ConnectTimeout == 0 {
		server.ConnectTimeout = 5 * time.Second
	}
	if server.HandshakeTimeout == 0 {
		server.HandshakeTimeout = 10 * time.Second
	}
	if server.CallTimeout == 0 {
		server.CallTimeout = 30 * time.Second
	}
	if server.TotalTimeout == 0 {
		server.TotalTimeout = 45 * time.Second
	}
	if server.MaxTextBytes == 0 {
		server.MaxTextBytes = 256 << 10
	}
	if server.MaxStructured == 0 {
		server.MaxStructured = 512 << 10
	}
	if server.MaxBinaryBytes == 0 {
		server.MaxBinaryBytes = 8 << 20
	}
}

func (server ServerConfig) validate(name string) error {
	parsed, err := url.Parse(server.URL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("MCP server %q URL must use HTTP or HTTPS", name)
	}
	if len(server.AllowedTools) == 0 && len(server.WriteTools) == 0 {
		return fmt.Errorf("MCP server %q has no allowed tools", name)
	}
	if (server.ClientCertFile == "") != (server.ClientKeyFile == "") {
		return fmt.Errorf("MCP server %q must configure both client certificate and key", name)
	}
	for _, value := range []time.Duration{server.ConnectTimeout, server.HandshakeTimeout, server.CallTimeout, server.TotalTimeout} {
		if value <= 0 {
			return fmt.Errorf("MCP server %q timeouts must be positive", name)
		}
	}
	if server.TotalTimeout < server.HandshakeTimeout || server.TotalTimeout < server.CallTimeout {
		return fmt.Errorf("MCP server %q total timeout is too small", name)
	}
	if server.MaxTextBytes <= 0 || server.MaxStructured <= 0 || server.MaxBinaryBytes <= 0 {
		return fmt.Errorf("MCP server %q result limits must be positive", name)
	}
	return nil
}

func recursiveDaguCall(server, tool string) bool {
	server = strings.ToLower(server)
	tool = strings.ToLower(tool)
	if server != "dagu" && !strings.Contains(server, "dagu") {
		return false
	}
	for _, operation := range []string{"run", "start", "execute", "enqueue", "retry", "cancel", "stop"} {
		if strings.Contains(tool, operation) {
			return true
		}
	}
	return false
}
