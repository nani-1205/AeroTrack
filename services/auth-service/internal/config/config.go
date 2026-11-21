// Package config loads the auth-service section (plus the shared block) from the
// single services JSON file (config/services.json).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// EnvConfigPath overrides the location of services.json (e.g. a Docker mount).
	EnvConfigPath     = "AEROTRACK_CONFIG"
	defaultConfigPath = "../../config/services.json"
	placeholder       = "CHANGE_ME"
)

type Postgres struct {
	Host                  string `json:"host"`
	Port                  int    `json:"port"`
	Database              string `json:"database"`
	SSLMode               string `json:"sslmode"`
	ConnectTimeoutSeconds int    `json:"connectTimeoutSeconds"`
	StartupRetries        int    `json:"startupRetries"`
}

type Redis struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Password string `json:"password"`
	DB       int    `json:"db"`
}

type JWT struct {
	Issuer            string `json:"issuer"`
	UserAudience      string `json:"userAudience"`
	AdminAudience     string `json:"adminAudience"`
	AccessTTLSeconds  int    `json:"accessTtlSeconds"`
	RefreshTTLSeconds int    `json:"refreshTtlSeconds"`
}

type Shared struct {
	Postgres      Postgres `json:"postgres"`
	Redis         Redis    `json:"redis"`
	JWT           JWT      `json:"jwt"`
	InternalToken string   `json:"internalToken"`
}

type DBCredentials struct {
	Schema   string `json:"schema"`
	User     string `json:"user"`
	Password string `json:"password"`
}

type GitHub struct {
	ClientID     string   `json:"clientId"`
	ClientSecret string   `json:"clientSecret"`
	CallbackURL  string   `json:"callbackUrl"`
	Scopes       []string `json:"scopes"`
}

type Admin struct {
	BootstrapUsername string `json:"bootstrapUsername"`
	BootstrapPassword string `json:"bootstrapPassword"`
	MaxFailedAttempts int    `json:"maxFailedAttempts"`
	LockoutMinutes    int    `json:"lockoutMinutes"`
}

type Portals struct {
	UserURL  string `json:"userUrl"`
	AdminURL string `json:"adminUrl"`
}

type Auth struct {
	Listen            string        `json:"listen"`
	DB                DBCredentials `json:"db"`
	GitHub            GitHub        `json:"github"`
	Admin             Admin         `json:"admin"`
	JWTPrivateKeyPath string        `json:"jwtPrivateKeyPath"`
	JWTPublicKeyPath  string        `json:"jwtPublicKeyPath"`
	Portals           Portals       `json:"portals"`
}

// Config is the slice of services.json this service cares about.
type Config struct {
	Env    string `json:"env"`
	Shared Shared `json:"shared"`
	Auth   Auth   `json:"auth"`

	// Path is the absolute path of the loaded file; relative paths inside it resolve against its directory.
	Path string `json:"-"`
}

func (c *Config) IsProduction() bool { return c.Env == "production" }

// ResolvePath resolves a path from the config file relative to the config file's directory.
func (c *Config) ResolvePath(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(filepath.Dir(c.Path), p)
}

// Load reads and validates services.json. Missing/placeholder values are fatal.
func Load() (*Config, error) {
	path := os.Getenv(EnvConfigPath)
	if path == "" {
		path = defaultConfigPath
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("read config %s (set %s to override): %w", abs, EnvConfigPath, err)
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", abs, err)
	}
	cfg.Path = abs
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("invalid config %s: %w", abs, err)
	}
	return &cfg, nil
}

// Warnings lists non-fatal gaps that are acceptable during development.
func (c *Config) Warnings() []string {
	var w []string
	if c.Auth.GitHub.ClientID == "" || c.Auth.GitHub.ClientSecret == "" {
		w = append(w, "auth.github.clientId/clientSecret are empty — GitHub SSO will not work until set")
	}
	return w
}

func (c *Config) validate() error {
	var errs []error
	required := map[string]string{
		"shared.postgres.host":         c.Shared.Postgres.Host,
		"shared.postgres.database":     c.Shared.Postgres.Database,
		"shared.redis.host":            c.Shared.Redis.Host,
		"shared.redis.password":        c.Shared.Redis.Password,
		"shared.jwt.issuer":            c.Shared.JWT.Issuer,
		"shared.jwt.userAudience":      c.Shared.JWT.UserAudience,
		"shared.jwt.adminAudience":     c.Shared.JWT.AdminAudience,
		"shared.internalToken":         c.Shared.InternalToken,
		"auth.listen":                  c.Auth.Listen,
		"auth.db.schema":               c.Auth.DB.Schema,
		"auth.db.user":                 c.Auth.DB.User,
		"auth.db.password":             c.Auth.DB.Password,
		"auth.admin.bootstrapUsername": c.Auth.Admin.BootstrapUsername,
		"auth.admin.bootstrapPassword": c.Auth.Admin.BootstrapPassword,
		"auth.jwtPrivateKeyPath":       c.Auth.JWTPrivateKeyPath,
		"auth.jwtPublicKeyPath":        c.Auth.JWTPublicKeyPath,
	}
	for key, val := range required {
		switch {
		case strings.TrimSpace(val) == "":
			errs = append(errs, fmt.Errorf("%s is required", key))
		case val == placeholder:
			errs = append(errs, fmt.Errorf("%s is still %q — run `npm run setup` or set a real value", key, placeholder))
		}
	}
	if c.Shared.Postgres.Port <= 0 || c.Shared.Redis.Port <= 0 {
		errs = append(errs, errors.New("shared.postgres.port and shared.redis.port must be > 0"))
	}
	if c.IsProduction() {
		for _, w := range c.Warnings() {
			errs = append(errs, errors.New(w))
		}
	}
	return errors.Join(errs...)
}
