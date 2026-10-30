package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)


const AgentVersion = "1.0.17"

type RemediationPolicy struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	Target     string  `json:"target"`
	Threshold  float64 `json:"threshold"`
	Script     string  `json:"script"`
	Cooldown   int     `json:"cooldown"`
	MaxRetries int     `json:"maxRetries"`
}

type Config struct {
	BackendURL          string              `json:"backendUrl"`
	APIKey              string              `json:"apiKey"`
	ReportInterval      int                 `json:"reportInterval"`
	WatchProcesses      []string            `json:"watchProcesses"`
	WatchServices       []string            `json:"watchServices"`
	PingTargets         []string            `json:"pingTargets"`
	TCPTargets          []string            `json:"tcpTargets"`
	RemediationPolicies []RemediationPolicy `json:"remediationPolicies"`
	LinuxLogPolicy      []LinuxLogPolicy    `json:"linuxLogPolicy"`
	LinuxLogPushPolicy  LinuxLogPushPolicy  `json:"linuxLogPushPolicy"`
	TlsEnabled          bool                `json:"tlsEnabled"`
	TlsSkipVerify       bool                `json:"tlsSkipVerify"`
	DisableReportLog    bool                `json:"disableReportLog,omitempty"`
	LogPath             string              `json:"logPath,omitempty"`
}

type LinuxLogPolicy struct {
	FilePath     string `json:"filePath"`
	Format       string `json:"format"`
	Tags         string `json:"tags"`
	IncludeRegex string `json:"includeRegex"`
	ExcludeRegex string `json:"excludeRegex"`
}

type LinuxLogPushPolicy struct {
	ElasticsearchEnabled bool             `json:"elasticsearchEnabled"`
	LogEnabled           bool             `json:"logEnabled"`
	URL                  string           `json:"url"`
	Username             string           `json:"username"`
	Password             string           `json:"password"`
	LogIndexName         string           `json:"logIndexName"`
	MetricsEnabled       bool             `json:"metricsEnabled"`
	MetricsIndexName     string           `json:"metricsIndexName"`
	Rules                []LinuxLogPolicy `json:"rules"`
}

type ForensicTask struct {
	ID       string                 `json:"id"`
	ScanType string                 `json:"scanType"`
	Params   map[string]interface{} `json:"params"`
}

type SyncResponse struct {
	Success      bool           `json:"success"`
	Config       struct {
		APIKey              string              `json:"apiKey"`
		ReportInterval      int                 `json:"reportInterval"`
		PingTargets         []string            `json:"pingTargets"`
		TCPTargets          []string            `json:"tcpTargets"`
		WatchProcesses      []string            `json:"watchProcesses"`
		WatchServices       []string            `json:"watchServices"`
		RemediationPolicies []RemediationPolicy `json:"remediationPolicies"`
		LinuxLogPolicy      []LinuxLogPolicy    `json:"linuxLogPolicy"`
		LinuxLogPushPolicy  LinuxLogPushPolicy  `json:"linuxLogPushPolicy"`
		TlsEnabled          bool                `json:"tlsEnabled"`
		TlsSkipVerify       bool                `json:"tlsSkipVerify"`
		DisableReportLog    *bool               `json:"disableReportLog"`
		LogPath             string              `json:"logPath"`
	} `json:"config"`
	PendingTasks []ForensicTask `json:"pendingTasks"`
}

func executeDeepScanLinux(cfg *Config, taskId string, params map[string]interface{}) {
	fmt.Printf("[Forensics] Starting Linux deep scan for task: %s\n", taskId)
	
	var linLogs []map[string]interface{}
	hostname, _ := os.Hostname()

	logFiles := []string{"/var/log/audit/audit.log", "/var/log/secure", "/var/log/auth.log"}
	for _, fp := range logFiles {
		if _, err := os.Stat(fp); err == nil {
			cmd := exec.Command("tail", "-n", "2000", fp)
			var out bytes.Buffer
			cmd.Stdout = &out
			if err := cmd.Run(); err == nil {
				lines := strings.Split(out.String(), "\n")
				for _, line := range lines {
					trimmed := strings.TrimSpace(line)
					if trimmed == "" {
						continue
					}
					logEntry := map[string]interface{}{
						"host":      hostname,
						"filePath":  fp,
						"format":    "syslog",
						"message":   trimmed,
						"tags":      "security,auth,audit",
						"raw":       trimmed,
						"timestamp": time.Now().UTC().Format(time.RFC3339),
					}
					linLogs = append(linLogs, logEntry)
				}
			}
		}
	}

	if len(linLogs) > 3000 {
		linLogs = linLogs[len(linLogs)-3000:]
	}

	uploadPayload := map[string]interface{}{
		"apiKey":  cfg.APIKey,
		"taskId":  taskId,
		"linLogs": linLogs,
	}

	uploadData, _ := json.Marshal(uploadPayload)
	client := getHTTPClient(30 * time.Second)
	
	resp, err := client.Post(cfg.BackendURL+"/api/monitor/forensics/upload", "application/json", bytes.NewBuffer(uploadData))
	if err != nil {
		fmt.Printf("[Forensics] Upload failed: %v\n", err)
	} else {
		fmt.Printf("[Forensics] Upload complete, status: %s\n", resp.Status)
		resp.Body.Close()
	}
}

type Payload struct {
	APIKey    string      `json:"apiKey"`
	Hostname  string      `json:"hostname"`
	IP        string      `json:"ip"`
	OS        string      `json:"os"`
	Version   string      `json:"version"`
	Timestamp string      `json:"timestamp"`
	Metrics   MetricsData `json:"metrics"`
}

type MetricsData struct {
	CPU         CPUData        `json:"cpu"`
	Memory      MemoryData     `json:"memory"`
	Disk        []DiskData     `json:"disk"`
	Ping        []PingData     `json:"ping"`
	TCP         []TCPData      `json:"tcp"`
	Processes   []ProcessData  `json:"processes"`
	Connections ConnectionData `json:"connections"`
	Network     NetworkData    `json:"network"`
	System      SystemData     `json:"system"`
}

type CPUData struct {
	Used float64 `json:"used"`
}

type MemoryData struct {
	Used    float64 `json:"used"`
	TotalMB float64 `json:"totalMB"`
}

type DiskData struct {
	Mount   string  `json:"mount"`
	Used    float64 `json:"used"`
	TotalGB float64 `json:"totalGB"`
}

type PingData struct {
	Target string  `json:"target"`
	RTTMs  float64 `json:"rttMs"`
	Lost   float64 `json:"lost"`
}

type TCPData struct {
	Host      string  `json:"host"`
	Port      string  `json:"port"`
	OK        bool    `json:"ok"`
	LatencyMs float64 `json:"latencyMs"`
}

type ProcessData struct {
	Name     string  `json:"name"`
	Status   string  `json:"status"`
	PID      int32   `json:"pid"`
	CPUUsage float64 `json:"cpuUsage"`
	MemoryMB float64 `json:"memoryMB"`
}

type ConnectionData struct {
	Established int `json:"established"`
	Listen      int `json:"listen"`
	TimeWait    int `json:"timeWait"`
	Total       int `json:"total"`
}

type NetworkData struct {
	RxBytes uint64  `json:"rxBytes"`
	TxBytes uint64  `json:"txBytes"`
	RxSpeed float64 `json:"rxSpeedKbps"`
	TxSpeed float64 `json:"txSpeedKbps"`
}

type SystemData struct {
	Uptime float64   `json:"uptime"`
	Load   *LoadData `json:"load,omitempty"`
}

type LoadData struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}

var (
	globalHTTPClient *http.Client
	clientInitOnce   sync.Once
	clientMutex      sync.Mutex
	lastClientReset  = time.Now()
	esHTTPClient     *http.Client
	esClientMutex    sync.Mutex
)

func getHTTPClient(timeout time.Duration) *http.Client {
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

		if config.TlsEnabled {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: config.TlsSkipVerify}
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

var config Config
var configPathGlobal string

func loadConfig() {
	exeDir, _ := filepath.Abs(filepath.Dir(os.Args[0]))
	configPath := filepath.Join(exeDir, "config.json")
	
	// fallback for systemd deployment
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		configPath = "/etc/scout/config.json"
	}
	configPathGlobal = configPath

	data, err := os.ReadFile(configPath)
	if err != nil {
		fmt.Printf("[Error] Cannot read config file from %s: %v\n", configPath, err)
		os.Exit(1)
	}

	err = json.Unmarshal(data, &config)
	if err != nil {
		fmt.Printf("[Error] Invalid config.json: %v\n", err)
		os.Exit(1)
	}

	if config.ReportInterval < 10 {
		config.ReportInterval = 60
	}
}

func getHostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

func getCPUFields() (float64, float64) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 {
		return 0, 0
	}
	fields := strings.Fields(lines[0])
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0
	}
	
	var user, nice, system, idle, iowait, irq, softirq, steal float64
	user, _ = strconv.ParseFloat(fields[1], 64)
	nice, _ = strconv.ParseFloat(fields[2], 64)
	system, _ = strconv.ParseFloat(fields[3], 64)
	idle, _ = strconv.ParseFloat(fields[4], 64)
	if len(fields) > 5 { iowait, _ = strconv.ParseFloat(fields[5], 64) }
	if len(fields) > 6 { irq, _ = strconv.ParseFloat(fields[6], 64) }
	if len(fields) > 7 { softirq, _ = strconv.ParseFloat(fields[7], 64) }
	if len(fields) > 8 { steal, _ = strconv.ParseFloat(fields[8], 64) }
	
	idleAll := idle + iowait
	nonIdle := user + nice + system + irq + softirq + steal
	total := idleAll + nonIdle
	return idleAll, total
}

func getCPU() CPUData {
	idle1, total1 := getCPUFields()
	time.Sleep(100 * time.Millisecond)
	idle2, total2 := getCPUFields()
	
	totalDiff := total2 - total1
	idleDiff := idle2 - idle1
	if totalDiff > 0 {
		usedPct := ((totalDiff - idleDiff) / totalDiff) * 100
		return CPUData{Used: usedPct}
	}
	return CPUData{Used: 0}
}

func getMemory() MemoryData {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return MemoryData{}
	}
	
	var memTotal, memAvailable, memFree, buffers, cached float64
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseFloat(fields[1], 64)
		if strings.HasPrefix(line, "MemTotal:") {
			memTotal = val
		} else if strings.HasPrefix(line, "MemAvailable:") {
			memAvailable = val
		} else if strings.HasPrefix(line, "MemFree:") {
			memFree = val
		} else if strings.HasPrefix(line, "Buffers:") {
			buffers = val
		} else if strings.HasPrefix(line, "Cached:") {
			cached = val
		}
	}
	
	if memTotal > 0 {
		if memAvailable == 0 {
			memAvailable = memFree + buffers + cached
		}
		used := memTotal - memAvailable
		usedPct := (used / memTotal) * 100
		return MemoryData{Used: usedPct, TotalMB: memTotal / 1024}
	}
	
	return MemoryData{}
}

func getDisk() []DiskData {
	var disks []DiskData
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return disks
	}
	
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		device := fields[0]
		mount := fields[1]
		
		if !strings.HasPrefix(device, "/dev/") {
			continue
		}
		
		var stat syscall.Statfs_t
		err := syscall.Statfs(mount, &stat)
		if err != nil {
			continue
		}
		
		total := float64(stat.Blocks) * float64(stat.Bsize)
		free := float64(stat.Bfree) * float64(stat.Bsize)
		used := total - free
		
		var usedPct float64
		if total > 0 {
			usedPct = (used / total) * 100
		}
		
		disks = append(disks, DiskData{
			Mount:   mount,
			Used:    usedPct,
			TotalGB: total / (1024 * 1024 * 1024),
		})
	}
	return disks
}

func getPing() []PingData {
	var pings []PingData
	for _, target := range config.PingTargets {
		start := time.Now()
		cmd := exec.Command("ping", "-c", "1", "-W", "1", target)
		err := cmd.Run()
		if err != nil {
			pings = append(pings, PingData{Target: target, RTTMs: -1, Lost: 100})
		} else {
			pings = append(pings, PingData{Target: target, RTTMs: float64(time.Since(start).Milliseconds()), Lost: 0})
		}
	}
	return pings
}

func getTCP() []TCPData {
	var tcps []TCPData
	for _, target := range config.TCPTargets {
		parts := strings.Split(target, ":")
		if len(parts) != 2 {
			continue
		}
		start := time.Now()
		conn, err := net.DialTimeout("tcp", target, 2*time.Second)
		if err != nil {
			tcps = append(tcps, TCPData{Host: parts[0], Port: parts[1], OK: false, LatencyMs: -1})
		} else {
			conn.Close()
			tcps = append(tcps, TCPData{Host: parts[0], Port: parts[1], OK: true, LatencyMs: float64(time.Since(start).Milliseconds())})
		}
	}
	return tcps
}

func getProcessMemoryMB(pidStr string) float64 {
	data, err := os.ReadFile("/proc/" + pidStr + "/status")
	if err != nil {
		return 0
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, _ := strconv.ParseFloat(fields[1], 64)
				return val / 1024
			}
		}
	}
	return 0
}

func getProcessCPUUsage(pidStr string) float64 {
	statData, err := os.ReadFile("/proc/" + pidStr + "/stat")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(statData))
	if len(fields) < 22 {
		return 0
	}
	utime, _ := strconv.ParseFloat(fields[13], 64)
	stime, _ := strconv.ParseFloat(fields[14], 64)
	starttime, _ := strconv.ParseFloat(fields[21], 64)

	uptimeData, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	uptimeFields := strings.Fields(string(uptimeData))
	if len(uptimeFields) < 1 {
		return 0
	}
	uptime, _ := strconv.ParseFloat(uptimeFields[0], 64)

	hertz := 100.0
	totalTime := utime + stime
	seconds := uptime - (starttime / hertz)

	if seconds <= 0 {
		return 0
	}
	return (totalTime / hertz) / seconds * 100
}

func getProcesses() []ProcessData {
	var procs []ProcessData
	if len(config.WatchProcesses) == 0 {
		return procs
	}
	
	targetMap := make(map[string]bool)
	for _, name := range config.WatchProcesses {
		targetMap[strings.ToLower(name)] = true
	}
	
	files, err := os.ReadDir("/proc")
	if err == nil {
		foundTargets := make(map[string]bool)
		for _, file := range files {
			if !file.IsDir() {
				continue
			}
			name := file.Name()
			if len(name) == 0 || name[0] < '0' || name[0] > '9' {
				continue
			}
			
			cmdlineBytes, err := os.ReadFile("/proc/" + name + "/cmdline")
			if err != nil {
				continue
			}
			
			cmdlineStr := strings.ReplaceAll(string(cmdlineBytes), "\x00", " ")
			
			// We can find matching watch names
			for _, watchName := range config.WatchProcesses {
				watchLower := strings.ToLower(watchName)
				if strings.Contains(strings.ToLower(cmdlineStr), watchLower) {
					foundTargets[watchLower] = true
					pidVal, _ := strconv.ParseInt(name, 10, 32)
					
					procs = append(procs, ProcessData{
						Name:     watchName,
						Status:   "running",
						PID:      int32(pidVal),
						CPUUsage: getProcessCPUUsage(name),
						MemoryMB: getProcessMemoryMB(name),
					})
				}
			}
		}
		
		// Add stopped processes
		for _, name := range config.WatchProcesses {
			nameLower := strings.ToLower(name)
			if !foundTargets[nameLower] {
				procs = append(procs, ProcessData{
					Name:     name,
					Status:   "stopped",
					PID:      0,
					CPUUsage: 0,
					MemoryMB: 0,
				})
			}
		}
	} else {
		for _, name := range config.WatchProcesses {
			procs = append(procs, ProcessData{
				Name:     name,
				Status:   "stopped",
				PID:      0,
				CPUUsage: 0,
				MemoryMB: 0,
			})
		}
	}
	return procs
}

func getConnections() ConnectionData {
	est := 0
	lis := 0
	tw := 0
	tot := 0

	paths := []string{"/proc/net/tcp", "/proc/net/tcp6"}
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		lines := strings.Split(string(data), "\n")
		for i := 1; i < len(lines); i++ {
			fields := strings.Fields(lines[i])
			if len(fields) < 4 {
				continue
			}
			st := fields[3]
			tot++
			switch st {
			case "01":
				est++
			case "0A":
				lis++
			case "06":
				tw++
			}
		}
	}
	return ConnectionData{
		Established: est,
		Listen:      lis,
		TimeWait:    tw,
		Total:       tot,
	}
}

var (
	netMutex    sync.Mutex
	lastRxBytes uint64
	lastTxBytes uint64
	lastNetTime time.Time
)

func getNetwork() NetworkData {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return NetworkData{}
	}
	var rxSum, txSum uint64
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) < 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		rxSum += rx
		txSum += tx
	}

	netMutex.Lock()
	defer netMutex.Unlock()

	now := time.Now()
	var rxSpeed, txSpeed float64
	if !lastNetTime.IsZero() && now.Sub(lastNetTime) > 0 {
		durationSec := now.Sub(lastNetTime).Seconds()
		if rxSum >= lastRxBytes {
			rxSpeed = float64(rxSum-lastRxBytes) / 1024.0 / durationSec
		}
		if txSum >= lastTxBytes {
			txSpeed = float64(txSum-lastTxBytes) / 1024.0 / durationSec
		}
	}
	lastRxBytes = rxSum
	lastTxBytes = txSum
	lastNetTime = now

	return NetworkData{
		RxBytes: rxSum,
		TxBytes: txSum,
		RxSpeed: rxSpeed,
		TxSpeed: txSpeed,
	}
}

func getSystem() SystemData {
	var uptime float64
	uptimeData, err := os.ReadFile("/proc/uptime")
	if err == nil {
		fields := strings.Fields(string(uptimeData))
		if len(fields) > 0 {
			uptime, _ = strconv.ParseFloat(fields[0], 64)
		}
	}

	load := &LoadData{}
	loadData, err := os.ReadFile("/proc/loadavg")
	if err == nil {
		fields := strings.Fields(string(loadData))
		if len(fields) >= 3 {
			load.Load1, _ = strconv.ParseFloat(fields[0], 64)
			load.Load5, _ = strconv.ParseFloat(fields[1], 64)
			load.Load15, _ = strconv.ParseFloat(fields[2], 64)
		}
	}

	return SystemData{
		Uptime: uptime,
		Load:   load,
	}
}

func collectMetrics() MetricsData {
	return MetricsData{
		CPU:         getCPU(),
		Memory:      getMemory(),
		Disk:        getDisk(),
		Ping:        getPing(),
		TCP:         getTCP(),
		Processes:   getProcesses(),
		Connections: getConnections(),
		Network:     getNetwork(),
		System:      getSystem(),
	}
}

type RemediationState struct {
	LastRun int64
	Retries int
}

var remediationStates = make(map[string]*RemediationState)

func evaluateRemediation(metrics MetricsData) {
	if len(config.RemediationPolicies) == 0 {
		return
	}

	for _, policy := range config.RemediationPolicies {
		isTriggered := false

		if policy.Type == "service" {
			// (Assuming Linux processes for services as watchServices is not fully implemented in getProcesses)
			for _, s := range metrics.Processes {
				if s.Name == policy.Target && s.Status == "stopped" {
					isTriggered = true
					break
				}
			}
		} else if policy.Type == "process" {
			for _, p := range metrics.Processes {
				if p.Name == policy.Target && p.Status == "stopped" {
					isTriggered = true
					break
				}
			}
		} else if policy.Type == "cpu" {
			if metrics.CPU.Used >= policy.Threshold {
				isTriggered = true
			}
		} else if policy.Type == "memory" {
			if metrics.Memory.Used >= policy.Threshold {
				isTriggered = true
			}
		}

		if isTriggered {
			stateKey := policy.ID
			if remediationStates[stateKey] == nil {
				remediationStates[stateKey] = &RemediationState{LastRun: 0, Retries: 0}
			}
			state := remediationStates[stateKey]
			now := time.Now().Unix()
			cooldown := int64(policy.Cooldown)
			if cooldown <= 0 {
				cooldown = 300
			}

			if now-state.LastRun > cooldown {
				if state.Retries < policy.MaxRetries {
					fmt.Printf("[Self-Healing] Triggered for rule %s (%s: %s). Executing script...\n", policy.ID, policy.Type, policy.Target)
					state.LastRun = now
					state.Retries++

					var output string
					var success bool
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					cmd := exec.CommandContext(ctx, "sh", "-c", policy.Script)
					out, err := cmd.CombinedOutput()
					cancel()
					if err != nil {
						if ctx.Err() == context.DeadlineExceeded {
							output = "Remediation command timed out after 30 seconds"
						} else {
							output = err.Error() + "\n" + string(out)
						}
						success = false
					} else {
						output = string(out)
						success = true
					}
					
					fmt.Printf("[Self-Healing] Result: %v\n", success)

					// Send to backend
					go func(p RemediationPolicy, out string, suc bool) {
						payload := map[string]interface{}{
							"apiKey":   config.APIKey,
							"hostname": getHostname(),
							"ip":       getLocalIP(),
							"ruleId":   p.ID,
							"type":     p.Type,
							"target":   p.Target,
							"script":   p.Script,
							"output":   out,
							"success":  suc,
						}
						jsonData, _ := json.Marshal(payload)
						client := getHTTPClient(10 * time.Second)
						baseURL := strings.TrimRight(config.BackendURL, "/")
						if config.TlsEnabled && strings.HasPrefix(baseURL, "http://") {
							baseURL = "https://" + strings.TrimPrefix(baseURL, "http://")
						}
						client.Post(baseURL+"/api/monitor/remediation", "application/json", bytes.NewBuffer(jsonData))
					}(policy, output, success)

				} else {
					fmt.Printf("[Self-Healing] Max retries (%d) reached for rule %s. Waiting for manual intervention.\n", policy.MaxRetries, policy.ID)
				}
			}
		} else {
			if remediationStates[policy.ID] != nil {
				remediationStates[policy.ID].Retries = 0
			}
		}
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func report() int {
	// Periodically clear idle connections and rebuild client every 24 hours
	clientMutex.Lock()
	if time.Since(lastClientReset) > 24*time.Hour {
		fmt.Println("[Scout] Periodically recycling HTTP connection pool (24h)...")
		if globalHTTPClient != nil {
			if transport, ok := globalHTTPClient.Transport.(*http.Transport); ok {
				transport.CloseIdleConnections()
			}
			globalHTTPClient = nil // Force recreation next time
		}
		lastClientReset = time.Now()
	}
	clientMutex.Unlock()

	metrics := collectMetrics()
	go pushMetricsToES(metrics)
	evaluateRemediation(metrics)

	payload := Payload{
		APIKey:    config.APIKey,
		Hostname:  getHostname(),
		IP:        getLocalIP(),
		OS:        runtime.GOOS,
		Version:   AgentVersion,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Metrics:   metrics,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		fmt.Println("[Error] json marshal:", err)
		return config.ReportInterval
	}

	client := getHTTPClient(10 * time.Second)
	baseURL := strings.TrimRight(config.BackendURL, "/")
	if config.TlsEnabled && strings.HasPrefix(baseURL, "http://") {
		baseURL = "https://" + strings.TrimPrefix(baseURL, "http://")
	}
	resp, err := client.Post(baseURL+"/api/monitor/report", "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		fmt.Printf("[%s] Report failed: %v\n", time.Now().Format(time.RFC3339), err)
		return config.ReportInterval
	}

	// Read body completely and close to reuse the connection
	body, readErr := io.ReadAll(resp.Body)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if resp.StatusCode == 200 {
		if !config.DisableReportLog {
			fmt.Printf("[%s] Report OK\n", time.Now().Format(time.RFC3339))
		}
		
		var apiResp SyncResponse
		if readErr == nil {
			err = json.Unmarshal(body, &apiResp)
		}
		if readErr == nil && err == nil && apiResp.Success {
			changed := false
			serverInterval := apiResp.Config.ReportInterval
			if serverInterval < 10 {
				serverInterval = 10
			}
			if serverInterval != config.ReportInterval {
				fmt.Printf("[Config Sync] reportInterval updated: %d -> %d\n", config.ReportInterval, serverInterval)
				config.ReportInterval = serverInterval
				changed = true
			}

			if !slicesEqual(config.PingTargets, apiResp.Config.PingTargets) {
				fmt.Printf("[Config Sync] pingTargets updated: %v -> %v\n", config.PingTargets, apiResp.Config.PingTargets)
				config.PingTargets = apiResp.Config.PingTargets
				if config.PingTargets == nil {
					config.PingTargets = []string{}
				}
				changed = true
			}

			if !slicesEqual(config.TCPTargets, apiResp.Config.TCPTargets) {
				fmt.Printf("[Config Sync] tcpTargets updated: %v -> %v\n", config.TCPTargets, apiResp.Config.TCPTargets)
				config.TCPTargets = apiResp.Config.TCPTargets
				if config.TCPTargets == nil {
					config.TCPTargets = []string{}
				}
				changed = true
			}

			if !slicesEqual(config.WatchProcesses, apiResp.Config.WatchProcesses) {
				fmt.Printf("[Config Sync] watchProcesses updated: %v -> %v\n", config.WatchProcesses, apiResp.Config.WatchProcesses)
				config.WatchProcesses = apiResp.Config.WatchProcesses
				if config.WatchProcesses == nil {
					config.WatchProcesses = []string{}
				}
				changed = true
			}

			if !slicesEqual(config.WatchServices, apiResp.Config.WatchServices) {
				fmt.Printf("[Config Sync] watchServices updated: %v -> %v\n", config.WatchServices, apiResp.Config.WatchServices)
				config.WatchServices = apiResp.Config.WatchServices
				if config.WatchServices == nil {
					config.WatchServices = []string{}
				}
				changed = true
			}

			// Sync RemediationPolicies
			oldPoliciesJSON, _ := json.Marshal(config.RemediationPolicies)
			newPoliciesJSON, _ := json.Marshal(apiResp.Config.RemediationPolicies)
			if string(oldPoliciesJSON) != string(newPoliciesJSON) {
				fmt.Printf("[Config Sync] remediationPolicies updated, count: %d\n", len(apiResp.Config.RemediationPolicies))
				config.RemediationPolicies = apiResp.Config.RemediationPolicies
				changed = true
			}

			// Sync Linux Log Policies (Backend)
			oldLogJSON, _ := json.Marshal(config.LinuxLogPolicy)
			newLogJSON, _ := json.Marshal(apiResp.Config.LinuxLogPolicy)
			if string(oldLogJSON) != string(newLogJSON) {
				fmt.Printf("[Config Sync] linuxLogPolicy updated, count: %d\n", len(apiResp.Config.LinuxLogPolicy))
				config.LinuxLogPolicy = apiResp.Config.LinuxLogPolicy
				UpdateBackendLogPolicy(apiResp.Config.LinuxLogPolicy)
				changed = true
			}

			// Sync Linux Log ES Push Policy (Elasticsearch)
			oldEsJSON, _ := json.Marshal(config.LinuxLogPushPolicy)
			newEsJSON, _ := json.Marshal(apiResp.Config.LinuxLogPushPolicy)
			if string(oldEsJSON) != string(newEsJSON) {
				fmt.Printf("[Config Sync] linuxLogPushPolicy updated, ES Enabled: %v\n", apiResp.Config.LinuxLogPushPolicy.ElasticsearchEnabled)
				config.LinuxLogPushPolicy = apiResp.Config.LinuxLogPushPolicy
				UpdateEsLogPolicy(apiResp.Config.LinuxLogPushPolicy)
				changed = true
			}

			if apiResp.Config.APIKey != "" && apiResp.Config.APIKey != config.APIKey {
				fmt.Printf("[Config Sync] apiKey updated: %s -> %s\n", config.APIKey, apiResp.Config.APIKey)
				config.APIKey = apiResp.Config.APIKey
				changed = true
			}

			if apiResp.Config.TlsEnabled != config.TlsEnabled {
				fmt.Printf("[Config Sync] tlsEnabled updated: %v -> %v\n", config.TlsEnabled, apiResp.Config.TlsEnabled)
				config.TlsEnabled = apiResp.Config.TlsEnabled
				changed = true
			}

			if apiResp.Config.TlsSkipVerify != config.TlsSkipVerify {
				fmt.Printf("[Config Sync] tlsSkipVerify updated: %v -> %v\n", config.TlsSkipVerify, apiResp.Config.TlsSkipVerify)
				config.TlsSkipVerify = apiResp.Config.TlsSkipVerify
				changed = true
			}

			if apiResp.Config.DisableReportLog != nil && *apiResp.Config.DisableReportLog != config.DisableReportLog {
				fmt.Printf("[Config Sync] disableReportLog updated: %v -> %v\n", config.DisableReportLog, *apiResp.Config.DisableReportLog)
				config.DisableReportLog = *apiResp.Config.DisableReportLog
				changed = true
			}

			if apiResp.Config.LogPath != "" && apiResp.Config.LogPath != config.LogPath {
				fmt.Printf("[Config Sync] logPath updated: %v -> %v\n", config.LogPath, apiResp.Config.LogPath)
				config.LogPath = apiResp.Config.LogPath
				changed = true
			}

			if changed && configPathGlobal != "" {
				data, err := json.MarshalIndent(config, "", "  ")
				if err == nil {
					err = os.WriteFile(configPathGlobal, data, 0644)
					if err == nil {
						fmt.Printf("[Config Sync] Saved updated config to %s\n", configPathGlobal)
					} else {
						fmt.Printf("[Config Sync] Failed to write config: %v\n", err)
					}
				}
			}

			// Dispatch pending forensics tasks
			for _, task := range apiResp.PendingTasks {
				if task.ScanType == "deep" {
					go executeDeepScanLinux(&config, task.ID, task.Params)
				}
			}
		}
	} else {
		fmt.Printf("[%s] Report Error %d: %s\n", time.Now().Format(time.RFC3339), resp.StatusCode, string(body))
	}
	return config.ReportInterval
}

func pushMetricsToES(metrics MetricsData) {
	if !config.LinuxLogPushPolicy.ElasticsearchEnabled || !config.LinuxLogPushPolicy.MetricsEnabled || config.LinuxLogPushPolicy.URL == "" {
		return
	}

	hostname := getHostname()

	// Flatten to ECS
	payload := make(map[string]interface{})
	payload["@timestamp"] = time.Now().UTC().Format(time.RFC3339)
	payload["event.dataset"] = "system.metrics"
	payload["host.name"] = hostname

	payload["system.cpu.total.norm.pct"] = metrics.CPU.Used / 100.0
	payload["system.memory.used.pct"] = metrics.Memory.Used / 100.0
	payload["system.memory.total"] = metrics.Memory.TotalMB * 1024 * 1024
	
	for _, d := range metrics.Disk {
		cleanMount := strings.ReplaceAll(d.Mount, "/", "_")
		if cleanMount == "_" {
			cleanMount = "root"
		}
		payload[fmt.Sprintf("system.filesystem.%s.used.pct", cleanMount)] = d.Used / 100.0
	}
	
	for _, p := range metrics.Processes {
		payload[fmt.Sprintf("process.%s.state", p.Name)] = p.Status
	}

	indexName := config.LinuxLogPushPolicy.MetricsIndexName
	if indexName == "" {
		indexName = "vanguard-metrics"
	}
	indexName = strings.ReplaceAll(indexName, "%Y", time.Now().Format("2006"))
	indexName = strings.ReplaceAll(indexName, "%m", time.Now().Format("01"))
	indexName = strings.ReplaceAll(indexName, "%d", time.Now().Format("02"))

	doc, _ := json.Marshal(payload)
	
	meta := fmt.Sprintf(`{"index":{"_index":"%s"}}`+"\n", indexName)
	var bulkBody []byte
	bulkBody = append(bulkBody, []byte(meta)...)
	bulkBody = append(bulkBody, doc...)
	bulkBody = append(bulkBody, '\n')

	client := getESHTTPClient(15 * time.Second)
	req, err := http.NewRequest("POST", config.LinuxLogPushPolicy.URL+"/_bulk", bytes.NewBuffer(bulkBody))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if config.LinuxLogPushPolicy.Username != "" {
		req.SetBasicAuth(config.LinuxLogPushPolicy.Username, config.LinuxLogPushPolicy.Password)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("[ES Metrics] Push failed:", err)
		return
	}
	defer resp.Body.Close()
	
	if resp.StatusCode >= 400 {
		fmt.Println("[ES Metrics] Push error, HTTP:", resp.StatusCode)
	}
}

func main() {
	fmt.Println("Starting Scout Agent (Linux)...")
	loadConfig()
	
	if config.LogPath != "" {
		f, err := os.OpenFile(config.LogPath, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0666)
		if err != nil {
			fmt.Printf("Failed to open LogPath: %v\n", err)
		} else {
			os.Stdout = f
			os.Stderr = f
		}
	}

	if len(config.LinuxLogPolicy) > 0 {
		UpdateBackendLogPolicy(config.LinuxLogPolicy)
	}
	if config.LinuxLogPushPolicy.ElasticsearchEnabled {
		UpdateEsLogPolicy(config.LinuxLogPushPolicy)
	}
	fmt.Printf("Backend URL: %s\n", config.BackendURL)
	fmt.Printf("Interval: %d seconds\n", config.ReportInterval)

	currentInterval := report() // First report immediately

	ticker := time.NewTicker(time.Duration(currentInterval) * time.Second)
	defer ticker.Stop()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	for {
		select {
		case <-ticker.C:
			newInterval := report()
			if newInterval != currentInterval {
				currentInterval = newInterval
			}
			
			// Apply Jitter +/- 10% (max +/- 5 seconds) on every tick reset
			jitterRange := currentInterval / 10
			if jitterRange < 1 {
				jitterRange = 1
			}
			if jitterRange > 5 {
				jitterRange = 5
			}
			randomJitter := rand.Intn(2*jitterRange+1) - jitterRange
			actualSleep := currentInterval + randomJitter
			if actualSleep < 5 {
				actualSleep = 5
			}
			
			ticker.Reset(time.Duration(actualSleep) * time.Second)
		case sig := <-sigChan:
			fmt.Printf("Received signal %v, shutting down gracefully...\n", sig)
			return
		}
	}
}
