package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	backendPolicies       []LinuxLogPolicy
	esPushPolicy          LinuxLogPushPolicy
	activeBackendTailCmds map[string]*exec.Cmd
	activeEsTailCmds      map[string]*exec.Cmd
	logtailMutex          sync.Mutex
)

func init() {
	activeBackendTailCmds = make(map[string]*exec.Cmd)
	activeEsTailCmds = make(map[string]*exec.Cmd)
}

func GetBackendLogPolicies() []LinuxLogPolicy {
	logtailMutex.Lock()
	defer logtailMutex.Unlock()
	return backendPolicies
}

func GetEsLogPushPolicy() LinuxLogPushPolicy {
	logtailMutex.Lock()
	defer logtailMutex.Unlock()
	return esPushPolicy
}

func UpdateBackendLogPolicy(policies []LinuxLogPolicy) {
	logtailMutex.Lock()
	defer logtailMutex.Unlock()

	// Stop old backend tail commands
	for file, cmd := range activeBackendTailCmds {
		fmt.Printf("[LogTail-Backend] Stopping tail for %s\n", file)
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		delete(activeBackendTailCmds, file)
	}

	backendPolicies = policies

	// Start new backend tail commands
	for _, p := range policies {
		if p.FilePath == "" {
			continue
		}
		go startWatcherWithRetry(p, "backend")
	}
}

func UpdateEsLogPolicy(policy LinuxLogPushPolicy) {
	logtailMutex.Lock()
	defer logtailMutex.Unlock()

	// Stop old ES tail commands
	for file, cmd := range activeEsTailCmds {
		fmt.Printf("[LogTail-ES] Stopping tail for %s\n", file)
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		delete(activeEsTailCmds, file)
	}

	esPushPolicy = policy

	if !policy.ElasticsearchEnabled || !policy.LogEnabled || policy.URL == "" {
		return
	}

	// Start new ES tail commands
	for _, p := range policy.Rules {
		if p.FilePath == "" {
			continue
		}
		go startWatcherWithRetry(p, "elasticsearch")
	}
}

func compileCaseInsensitiveRegex(pattern string) *regexp.Regexp {
	if strings.TrimSpace(pattern) == "" {
		return nil
	}
	expr := strings.TrimSpace(pattern)
	if !strings.HasPrefix(expr, "(?i)") {
		expr = "(?i)" + expr
	}
	r, err := regexp.Compile(expr)
	if err != nil {
		r, _ = regexp.Compile(pattern)
	}
	return r
}

func startWatcherWithRetry(policy LinuxLogPolicy, dest string) {
	for {
		// Verify if the policy is still active and get the latest config
		logtailMutex.Lock()
		stillActive := false
		activePolicy := policy
		if dest == "backend" {
			for _, cp := range backendPolicies {
				if cp.FilePath == policy.FilePath {
					stillActive = true
					activePolicy = cp
					break
				}
			}
		} else {
			if esPushPolicy.ElasticsearchEnabled && esPushPolicy.LogEnabled {
				for _, cp := range esPushPolicy.Rules {
					if cp.FilePath == policy.FilePath {
						stillActive = true
						activePolicy = cp
						break
					}
				}
			}
		}
		logtailMutex.Unlock()

		if !stillActive {
			break
		}

		fmt.Printf("[LogTail-%s] Starting/Restarting tail for %s (format: %s, exclude: %s)\n", dest, activePolicy.FilePath, activePolicy.Format, activePolicy.ExcludeRegex)
		cmd := exec.Command("tail", "-F", activePolicy.FilePath)
		
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			fmt.Printf("[LogTail-%s] Failed to get stdout for %s: %v\n", dest, activePolicy.FilePath, err)
			time.Sleep(5 * time.Second)
			continue
		}

		if err := cmd.Start(); err != nil {
			fmt.Printf("[LogTail-%s] Failed to start tail for %s: %v\n", dest, activePolicy.FilePath, err)
			time.Sleep(5 * time.Second)
			continue
		}

		logtailMutex.Lock()
		if dest == "backend" {
			activeBackendTailCmds[activePolicy.FilePath] = cmd
		} else {
			activeEsTailCmds[activePolicy.FilePath] = cmd
		}
		logtailMutex.Unlock()

		// Read output from stream blockingly until it closes or fails
		processLogStream(activePolicy, stdout, dest)

		// Wait for command to release resources
		cmd.Wait()

		// Short throttle before restarting to avoid CPU thrashing
		time.Sleep(2 * time.Second)
	}
}

func processLogStream(policy LinuxLogPolicy, stdout io.Reader, dest string) {
	scanner := bufio.NewScanner(stdout)
	
	var incRegex *regexp.Regexp
	var excRegex *regexp.Regexp
	
	if policy.IncludeRegex != "" {
		incRegex = compileCaseInsensitiveRegex(policy.IncludeRegex)
	}
	if policy.ExcludeRegex != "" {
		excRegex = compileCaseInsensitiveRegex(policy.ExcludeRegex)
	}

	// Batch events to avoid spamming target
	var batch []map[string]interface{}
	batchMu := sync.Mutex{}
	
	done := make(chan struct{})

	// Flusher routine
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				batchMu.Lock()
				if len(batch) > 0 {
					if dest == "backend" {
						pushToBackend(batch)
					} else {
						pushDirectToES(batch)
					}
					batch = make([]map[string]interface{}, 0)
				}
				batchMu.Unlock()
			case <-done:
				batchMu.Lock()
				if len(batch) > 0 {
					if dest == "backend" {
						pushToBackend(batch)
					} else {
						pushDirectToES(batch)
					}
				}
				batchMu.Unlock()
				return
			}
		}
	}()

	for scanner.Scan() {
		line := scanner.Text()
		
		// Regex Filtering
		if incRegex != nil && !incRegex.MatchString(line) {
			continue
		}
		if excRegex != nil && excRegex.MatchString(line) {
			continue
		}

		// Normalize tags
		var tags []string
		for _, t := range strings.Split(policy.Tags, ",") {
			tags = append(tags, strings.TrimSpace(t))
		}

		hostname := getHostname()
		localIP := getLocalIP()
		format := policy.Format
		if format == "" {
			format = "syslog"
		}

		event := map[string]interface{}{
			"@timestamp": time.Now().UTC().Format(time.RFC3339),
			"ecs":        map[string]interface{}{"version": "8.11.0"},
			"host": map[string]interface{}{
				"id":       hostname,
				"name":     hostname,
				"hostname": hostname,
				"ip":       []string{localIP},
				"os": map[string]interface{}{
					"type":     "linux",
					"family":   "linux",
					"platform": "linux",
				},
			},
			"agent": map[string]interface{}{
				"id":      config.APIKey,
				"type":    "scout-linux",
				"version": "1.2.0",
				"name":    hostname,
			},
			"log": map[string]interface{}{
				"file": map[string]interface{}{"path": policy.FilePath},
			},
			"event": map[string]interface{}{
				"kind":     "event",
				"category": []string{"host"},
				"module":   format,
				"dataset":  fmt.Sprintf("system.%s", format),
			},
			"tags":    tags,
			"message": line,
		}

		batchMu.Lock()
		batch = append(batch, event)
		batchMu.Unlock()
	}
	close(done)
}

func pushToBackend(events []map[string]interface{}) {
	baseURL := strings.TrimRight(config.BackendURL, "/")
	if baseURL == "" {
		return
	}
	
	payload := map[string]interface{}{
		"apiKey":   config.APIKey,
		"hostname": getHostname(),
		"events":   events,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return
	}

	client := getHTTPClient(10 * time.Second)
	if config.TlsEnabled && strings.HasPrefix(baseURL, "http://") {
		baseURL = "https://" + strings.TrimPrefix(baseURL, "http://")
	}
	client.Post(baseURL+"/api/monitor/event", "application/json", bytes.NewBuffer(jsonData))
}

func pushDirectToES(events []map[string]interface{}) {
	logtailMutex.Lock()
	esConf := esPushPolicy
	logtailMutex.Unlock()

	if esConf.URL == "" {
		return
	}

	var bulkData bytes.Buffer
	indexName := esConf.LogIndexName
	if indexName == "" {
		indexName = "scout-linux"
	}
	indexName = strings.ReplaceAll(indexName, "%Y", time.Now().Format("2006"))
	indexName = strings.ReplaceAll(indexName, "%m", time.Now().Format("01"))
	indexName = strings.ReplaceAll(indexName, "%d", time.Now().Format("02"))
	
	for _, ev := range events {
		meta := map[string]interface{}{
			"index": map[string]interface{}{
				"_index": indexName,
			},
		}
		metaJSON, _ := json.Marshal(meta)
		evJSON, _ := json.Marshal(ev)
		
		bulkData.Write(metaJSON)
		bulkData.WriteByte('\n')
		bulkData.Write(evJSON)
		bulkData.WriteByte('\n')
	}

	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{
		Transport: tr,
		Timeout:   15 * time.Second,
	}
	url := strings.TrimRight(esConf.URL, "/") + "/_bulk"
	req, err := http.NewRequest("POST", url, &bulkData)
	if err != nil {
		return
	}

	req.Header.Set("Content-Type", "application/x-ndjson")
	if esConf.Username != "" && esConf.Password != "" {
		req.SetBasicAuth(esConf.Username, esConf.Password)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[LogTail-ES] Failed to push directly to ES: %v\n", err)
		return
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		fmt.Printf("[LogTail-ES] Push failed with status %d: %s\n", resp.StatusCode, string(body))
	} else {
		fmt.Printf("[LogTail-ES] Successfully pushed %d events directly to ES\n", len(events))
	}
}
