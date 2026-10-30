package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

var ConfigMutex sync.RWMutex
var config *Config



type Config struct {
	APIKey              string                   `json:"apiKey"`
	BackendURL          string                   `json:"backendUrl"`
	ReportInterval      int                      `json:"reportInterval"`
	PingTargets         []string                 `json:"pingTargets"`
	TCPTargets          []string                 `json:"tcpTargets"`
	WatchServices       []string                 `json:"watchServices"`
	WatchProcesses      []string                 `json:"watchProcesses"`
	RemediationPolicies []map[string]interface{} `json:"remediationPolicies,omitempty"`
	WindowsEventPolicy  []WindowsEventRule       `json:"windowsEventPolicy,omitempty"`
	WindowsEventPush    *WindowsEventPushPolicy  `json:"windowsEventPushPolicy,omitempty"`
	TlsEnabled          bool                     `json:"tlsEnabled"`
	TlsSkipVerify       bool                     `json:"tlsSkipVerify"`
}

type WindowsEventRule struct {
	LogName      string `json:"logName"`
	IncludeIds   string `json:"includeIds"`
	ExcludeIds   string `json:"excludeIds"`
	ExcludeUsers string `json:"excludeUsers,omitempty"`
	Severity     string `json:"severity"`
}

type WindowsEventPushPolicy struct {
	ElasticsearchEnabled bool   `json:"elasticsearchEnabled"`
	LogEnabled           bool   `json:"logEnabled"`
	URL                  string `json:"url"`
	Username             string `json:"username"`
	Password             string `json:"password"`
	LogIndexName         string `json:"logIndexName"`
	MetricsEnabled       bool   `json:"metricsEnabled"`
	MetricsIndexName     string `json:"metricsIndexName"`
	YamlConfig           string `json:"yamlConfig"`
}

var configPathGlobal string

func LoadConfig() (*Config, error) {
	exeDir, err := os.Executable()
	if err != nil {
		return nil, err
	}
	exeDir = filepath.Dir(exeDir)

	cwd, _ := os.Getwd()
	cwdPath := filepath.Join(cwd, "config.json")
	configPath := filepath.Join(exeDir, "config.json")

	if _, err := os.Stat(cwdPath); err == nil {
		configPath = cwdPath
	}

	configPathGlobal = configPath

	file, err := os.ReadFile(configPath)
	if err != nil {
		defaultConfig := &Config{
			APIKey:         "CHANGE_ME",
			BackendURL:     "http://192.168.1.100:3000",
			ReportInterval: 60,
			PingTargets:    []string{"8.8.8.8"},
		}
		SaveConfig(defaultConfig)
		return defaultConfig, nil
	}

	if len(file) >= 3 && file[0] == 0xEF && file[1] == 0xBB && file[2] == 0xBF {
		file = file[3:]
	}

	var config Config
	if err := json.Unmarshal(file, &config); err != nil {
		return nil, err
	}

	if config.ReportInterval < 10 {
		config.ReportInterval = 60
	}

	return &config, nil
}

func SaveConfig(config *Config) error {
	if configPathGlobal == "" {
		return nil
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPathGlobal, data, 0644)
}
