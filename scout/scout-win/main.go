package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const AgentVersion = "1.0.21"

var (
	globalHTTPClient *http.Client
	clientInitOnce   sync.Once
	clientMutex      sync.Mutex
	lastClientReset  = time.Now()
	esHTTPClient     *http.Client
	esClientMutex    sync.Mutex
)

func getHTTPClient(timeout time.Duration) *http.Client {
	ConfigMutex.RLock()
	tlsEnabled := config.TlsEnabled
	tlsSkipVerify := config.TlsSkipVerify
	ConfigMutex.RUnlock()

	clientMutex.Lock()
	defer clientMutex.Unlock()

	if globalHTTPClient == nil {
		transport := &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}

		if tlsEnabled {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: tlsSkipVerify}
		} else {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		}

		globalHTTPClient = &http.Client{
			Transport: transport,
			Timeout:   timeout,
		}
	}
	return globalHTTPClient
}

func getESHTTPClient(timeout time.Duration) *http.Client {
	esClientMutex.Lock()
	defer esClientMutex.Unlock()

	if esHTTPClient == nil {
		transport := &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			TLSClientConfig:       &tls.Config{InsecureSkipVerify: true},
		}

		esHTTPClient = &http.Client{
			Transport: transport,
			Timeout:   timeout,
		}
	}
	return esHTTPClient
}

func main() {
	log.SetOutput(os.Stdout)
	

	
	var err error
	config, err = LoadConfig()
	if err != nil {
		log.Println("Error loading config:", err)
		return
	}

	log.Println("Starting Scout-Win Agent...")
	log.Println("Backend URL:", config.BackendURL)

	go ReportLoop(config)
	go EventLoop(config)
	go ESPushLoop(config)

	// Keep alive
	select {}
}

func getOutboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

type ForensicTask struct {
	ID       string                 `json:"id"`
	ScanType string                 `json:"scanType"`
	Params   map[string]interface{} `json:"params"`
}

func executeDeepScanWin(cfg *Config, taskId string, params map[string]interface{}) {
	log.Println("[Forensics] Starting deep scan for task:", taskId)
	days := 7
	if d, ok := params["days"].(float64); ok {
		days = int(d)
	}

	// Fetch security event logs using PowerShell command (fast and pre-formatted)
	psCmd := fmt.Sprintf("Get-WinEvent -FilterHashtable @{LogName='Security'; StartTime=(Get-Date).AddDays(-%d)} -ErrorAction SilentlyContinue | Select-Object -First 1000 | ForEach-Object { [PSCustomObject]@{ eventID=$_.Id; level=$_.LevelDisplayName; host=$_.MachineName; provider=$_.ProviderName; message=$_.Message; timestamp=$_.TimeCreated.ToString('o') } } | ConvertTo-Json", days)
	
	cmd := exec.Command("powershell", "-Command", psCmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		log.Println("[Forensics] PowerShell deep scan failed:", err)
		return
	}

	var winLogs []map[string]interface{}
	json.Unmarshal(out.Bytes(), &winLogs)

	uploadPayload := map[string]interface{}{
		"apiKey":  cfg.APIKey,
		"taskId":  taskId,
		"winLogs": winLogs,
	}

	uploadData, _ := json.Marshal(uploadPayload)
	client := getHTTPClient(30 * time.Second)
	resp, err := client.Post(cfg.BackendURL+"/api/monitor/forensics/upload", "application/json", bytes.NewBuffer(uploadData))
	if err != nil {
		log.Println("[Forensics] Upload failed:", err)
	} else {
		log.Println("[Forensics] Upload complete, status:", resp.Status)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

func ReportLoop(config *Config) {
	for {
		// Periodically clear idle connections and rebuild client every 24 hours
		clientMutex.Lock()
		if time.Since(lastClientReset) > 24*time.Hour {
			log.Println("[Scout] Periodically recycling HTTP connection pool (24h)...")
			if globalHTTPClient != nil {
				if transport, ok := globalHTTPClient.Transport.(*http.Transport); ok {
					transport.CloseIdleConnections()
				}
				globalHTTPClient = nil // Force recreation next time
			}
			lastClientReset = time.Now()
		}
		clientMutex.Unlock()

		metrics := CollectMetrics(config)
		go PushMetricsToES(config, metrics)
		go EvaluateRemediation(config, metrics)
		
		hostname, _ := os.Hostname()

		ConfigMutex.RLock()
		payload := map[string]interface{}{
			"apiKey":    config.APIKey,
			"hostname":  hostname,
			"ip":        getOutboundIP(),
			"os":        "windows",
			"version":   AgentVersion,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"metrics":   metrics,
		}
		backendUrl := config.BackendURL
		ConfigMutex.RUnlock()

		data, _ := json.Marshal(payload)
		client := getHTTPClient(10 * time.Second)
		ConfigMutex.RLock()
		tlsEnabled := config.TlsEnabled
		ConfigMutex.RUnlock()

		if tlsEnabled && strings.HasPrefix(backendUrl, "http://") {
			backendUrl = "https://" + strings.TrimPrefix(backendUrl, "http://")
		}

		resp, err := client.Post(backendUrl+"/api/monitor/report", "application/json", bytes.NewBuffer(data))
		if err != nil {
			log.Println("Report failed:", err)
		} else {
			log.Println("Report status:", resp.StatusCode)
			if resp.StatusCode != 200 {
				log.Printf("sendReport: HTTP %d", resp.StatusCode)
			}
			bodyBytes, readErr := io.ReadAll(resp.Body)
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			
			if readErr == nil {
				var respData struct {
					Success      bool           `json:"success"`
					Config       *Config        `json:"config"`
					PendingTasks []ForensicTask `json:"pendingTasks"`
				}
				if err := json.Unmarshal(bodyBytes, &respData); err == nil && respData.Success {
					if respData.Config != nil {
						ConfigMutex.Lock()
						oldBytes, _ := json.Marshal(config)
						
						config.ReportInterval = respData.Config.ReportInterval
						config.PingTargets = respData.Config.PingTargets
						config.TCPTargets = respData.Config.TCPTargets
						config.WatchServices = respData.Config.WatchServices
						config.WatchProcesses = respData.Config.WatchProcesses
						config.RemediationPolicies = respData.Config.RemediationPolicies
						config.WindowsEventPolicy = respData.Config.WindowsEventPolicy
						config.WindowsEventPush = respData.Config.WindowsEventPush
						config.TlsEnabled = respData.Config.TlsEnabled
						config.TlsSkipVerify = respData.Config.TlsSkipVerify
						if respData.Config.APIKey != "" {
							config.APIKey = respData.Config.APIKey
						}
						if config.ReportInterval < 10 {
							config.ReportInterval = 60
						}
						
						newBytes, _ := json.Marshal(config)
						changed := string(oldBytes) != string(newBytes)
						ConfigMutex.Unlock()
						
						if changed {
							SaveConfig(config)
							log.Println("Config synchronized from server.")
						}
					}

					// Dispatch pending forensics tasks
					for _, task := range respData.PendingTasks {
						if task.ScanType == "deep" {
							go executeDeepScanWin(config, task.ID, task.Params)
						}
					}
				}
			}
		}

		ConfigMutex.RLock()
		interval := config.ReportInterval
		ConfigMutex.RUnlock()

		// Apply Jitter +/- 10% (max +/- 5 seconds)
		jitterRange := interval / 10
		if jitterRange < 1 {
			jitterRange = 1
		}
		if jitterRange > 5 {
			jitterRange = 5
		}
		randomJitter := rand.Intn(2*jitterRange+1) - jitterRange
		actualSleep := interval + randomJitter
		if actualSleep < 5 {
			actualSleep = 5
		}

		time.Sleep(time.Duration(actualSleep) * time.Second)
	}
}
