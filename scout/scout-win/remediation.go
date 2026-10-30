package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type RemediationState struct {
	LastRun time.Time
	Retries int
}

var (
	remediationStates = make(map[string]*RemediationState)
	remediationMutex  sync.Mutex
)

func EvaluateRemediation(config *Config, metrics *Metrics) {
	ConfigMutex.RLock()
	policies := append([]map[string]interface{}(nil), config.RemediationPolicies...)
	apiKey := config.APIKey
	backendUrl := config.BackendURL
	tlsEnabled := config.TlsEnabled
	ConfigMutex.RUnlock()

	if len(policies) == 0 {
		return
	}

	now := time.Now()
	hostname, _ := os.Hostname()

	for _, p := range policies {
		policyId, _ := p["id"].(string)
		pType, _ := p["type"].(string)
		target, _ := p["target"].(string)
		script, _ := p["script"].(string)
		
		threshold := 0.0
		if val, ok := p["threshold"].(float64); ok {
			threshold = val
		}

		cooldown := 300 * time.Second
		if val, ok := p["cooldown"].(float64); ok && val > 0 {
			cooldown = time.Duration(val) * time.Second
		}
		
		maxRetries := 0
		if val, ok := p["maxRetries"].(float64); ok {
			maxRetries = int(val)
		}

		isTriggered := false

		switch pType {
		case "service":
			if metrics.Services != nil {
				for _, s := range metrics.Services {
					if s.Name == target && s.Status == "stopped" {
						isTriggered = true
						break
					}
				}
			}
		case "process":
			if metrics.Processes != nil {
				for _, proc := range metrics.Processes {
					if proc.Name == target && proc.Status == "stopped" {
						isTriggered = true
						break
					}
				}
			}
		case "cpu":
			if metrics.CPU != nil && metrics.CPU.Used >= threshold {
				isTriggered = true
			}
		case "memory":
			if metrics.Memory != nil && metrics.Memory.Used >= threshold {
				isTriggered = true
			}
		}

		if isTriggered && policyId != "" && script != "" {
			remediationMutex.Lock()
			state, exists := remediationStates[policyId]
			if !exists {
				state = &RemediationState{}
				remediationStates[policyId] = state
			}
			
			if now.Sub(state.LastRun) > cooldown {
				if state.Retries < maxRetries {
					log.Printf("[Self-Healing] Triggered for rule %s (%s: %s). Executing script...", policyId, pType, target)
					state.LastRun = now
					state.Retries++
					remediationMutex.Unlock()

					// Execute script
					cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
					out, err := cmd.CombinedOutput()
					
					success := err == nil
					outputStr := string(out)
					if err != nil && outputStr == "" {
						outputStr = err.Error()
					}

					log.Printf("[Self-Healing] Result: %v", success)

					// Send result to backend
					payload := map[string]interface{}{
						"apiKey":   apiKey,
						"hostname": hostname,
						"policyId": policyId,
						"success":  success,
						"output":   outputStr,
					}
					data, _ := json.Marshal(payload)

					client := getHTTPClient(10 * time.Second)
					
					if tlsEnabled && strings.HasPrefix(backendUrl, "http://") {
						backendUrl = "https://" + strings.TrimPrefix(backendUrl, "http://")
					}

					resp, reqErr := client.Post(strings.TrimSuffix(backendUrl, "/")+"/api/monitor/remediation", "application/json", bytes.NewBuffer(data))
					if reqErr == nil {
						io.Copy(io.Discard, resp.Body)
						resp.Body.Close()
					} else {
						log.Printf("[Self-Healing] Failed to report to backend: %v", reqErr)
					}

				} else {
					remediationMutex.Unlock()
				}
			} else {
				remediationMutex.Unlock()
			}
		}
	}
}
