package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

type Metrics struct {
	CPU         *CPUInfo      `json:"cpu"`
	Memory      *MemoryInfo   `json:"memory"`
	Disk        []DiskInfo    `json:"disk"`
	Ping        []PingInfo    `json:"ping"`
	TCP         []TCPInfo     `json:"tcp"`
	Services    []ServiceInfo `json:"services"`
	Processes   []ProcessInfo `json:"processes"`
	Connections ConnectionData `json:"connections"`
	Network     NetworkData    `json:"network"`
	System      SystemData     `json:"system"`
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
	Uptime float64 `json:"uptime"`
}

type CPUInfo struct {
	Used float64 `json:"used"`
}

type MemoryInfo struct {
	Used    float64 `json:"used"`
	TotalMB float64 `json:"totalMB"`
}

type DiskInfo struct {
	Mount   string  `json:"mount"`
	Used    float64 `json:"used"`
	TotalGB float64 `json:"totalGB"`
}

type PingInfo struct {
	Target string  `json:"target"`
	RTTMs  float64 `json:"rttMs"`
	Lost   float64 `json:"lost"`
}

type TCPInfo struct {
	Host      string  `json:"host"`
	Port      string  `json:"port"`
	OK        bool    `json:"ok"`
	LatencyMs float64 `json:"latencyMs"`
}

type ServiceInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

type ProcessInfo struct {
	Name     string  `json:"name"`
	Status   string  `json:"status"`
	PID      int32   `json:"pid"`
	CPUUsage float64 `json:"cpuUsage"`
	MemoryMB float64 `json:"memoryMB"`
}

func getWindowsServiceStatus(serviceName string) string {
	m, err := mgr.Connect()
	if err != nil {
		return "stopped"
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return "stopped"
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return "stopped"
	}

	if status.State == windows.SERVICE_RUNNING {
		return "running"
	}
	return "stopped"
}

func getRunningProcesses() (map[string]bool, error) {
	running := make(map[string]bool)
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}
	for _, p := range procs {
		name, err := p.Name()
		if err == nil {
			running[strings.ToLower(name)] = true
		}
	}
	return running, nil
}

func CollectMetrics(config *Config) *Metrics {
	m := &Metrics{}

	ConfigMutex.RLock()
	pingTargets := append([]string(nil), config.PingTargets...)
	tcpTargets := append([]string(nil), config.TCPTargets...)
	watchServices := append([]string(nil), config.WatchServices...)
	watchProcesses := append([]string(nil), config.WatchProcesses...)
	ConfigMutex.RUnlock()

	if p, err := cpu.Percent(0, false); err == nil && len(p) > 0 {
		m.CPU = &CPUInfo{Used: p[0]}
	}

	if v, err := mem.VirtualMemory(); err == nil {
		m.Memory = &MemoryInfo{
			Used:    v.UsedPercent,
			TotalMB: float64(v.Total) / 1024 / 1024,
		}
	}

	if parts, err := disk.Partitions(false); err == nil {
		for _, part := range parts {
			if strings.HasPrefix(part.Device, "C:") || part.Fstype == "NTFS" {
				if u, err := disk.Usage(part.Mountpoint); err == nil {
					m.Disk = append(m.Disk, DiskInfo{
						Mount:   part.Device + "\\",
						Used:    u.UsedPercent,
						TotalGB: float64(u.Total) / 1024 / 1024 / 1024,
					})
				}
			}
		}
	}

	// Parallel ping targets
	if len(pingTargets) > 0 {
		var pingMutex sync.Mutex
		var wg sync.WaitGroup
		m.Ping = make([]PingInfo, 0, len(pingTargets))
		for _, target := range pingTargets {
			wg.Add(1)
			go func(t string) {
				defer wg.Done()
				out, _ := exec.Command("ping", "-n", "1", "-w", "1000", t).Output()
				rtt := float64(-1)
				lost := float64(100)
				if strings.Contains(string(out), "TTL=") {
					rtt = 1
					lost = 0
				}
				pingMutex.Lock()
				m.Ping = append(m.Ping, PingInfo{Target: t, RTTMs: rtt, Lost: lost})
				pingMutex.Unlock()
			}(target)
		}
		wg.Wait()
	}

	for _, target := range tcpTargets {
		parts := strings.Split(target, ":")
		if len(parts) == 2 {
			start := time.Now()
			conn, err := net.DialTimeout("tcp", target, 2*time.Second)
			if err == nil {
				conn.Close()
				m.TCP = append(m.TCP, TCPInfo{Host: parts[0], Port: parts[1], OK: true, LatencyMs: float64(time.Since(start).Milliseconds())})
			} else {
				m.TCP = append(m.TCP, TCPInfo{Host: parts[0], Port: parts[1], OK: false, LatencyMs: -1})
			}
		}
	}

	for _, srv := range watchServices {
		status := getWindowsServiceStatus(srv)
		m.Services = append(m.Services, ServiceInfo{Name: srv, Status: status})
	}

	if len(watchProcesses) > 0 {
		targetMap := make(map[string]bool)
		for _, p := range watchProcesses {
			targetMap[strings.ToLower(p)] = true
		}

		procs, err := process.Processes()
		if err == nil {
			foundTargets := make(map[string]bool)

			for _, p := range procs {
				name, err := p.Name()
				if err != nil {
					continue
				}
				nameLower := strings.ToLower(name)
				if targetMap[nameLower] {
					foundTargets[nameLower] = true
					
					cpuPercent, _ := p.CPUPercent()
					memInfo, _ := p.MemoryInfo()
					var memoryMB float64
					if memInfo != nil {
						memoryMB = float64(memInfo.RSS) / 1024 / 1024
					}
					
					m.Processes = append(m.Processes, ProcessInfo{
						Name:     name,
						Status:   "running",
						PID:      p.Pid,
						CPUUsage: cpuPercent,
						MemoryMB: memoryMB,
					})
				}
			}

			for _, proc := range watchProcesses {
				procLower := strings.ToLower(proc)
				if !foundTargets[procLower] {
					m.Processes = append(m.Processes, ProcessInfo{
						Name:     proc,
						Status:   "stopped",
						PID:      0,
						CPUUsage: 0,
						MemoryMB: 0,
					})
				}
			}
		} else {
			for _, proc := range watchProcesses {
				m.Processes = append(m.Processes, ProcessInfo{
					Name:     proc,
					Status:   "stopped",
					PID:      0,
					CPUUsage: 0,
					MemoryMB: 0,
				})
			}
		}
	}

	m.Connections = getWindowsConnections()
	m.Network = getWindowsNetwork()
	up, _ := host.Uptime()
	m.System = SystemData{
		Uptime: float64(up),
	}

	return m
}

func getWindowsConnections() ConnectionData {
	out, err := exec.Command("netstat", "-an").Output()
	if err != nil {
		return ConnectionData{}
	}
	est := 0
	lis := 0
	tw := 0
	tot := 0
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.ToUpper(strings.TrimSpace(line))
		if !strings.HasPrefix(line, "TCP") && !strings.HasPrefix(line, "UDP") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		tot++
		if len(fields) >= 4 {
			state := fields[3]
			if strings.Contains(state, "ESTABLISHED") {
				est++
			} else if strings.Contains(state, "LISTENING") {
				lis++
			} else if strings.Contains(state, "TIME_WAIT") {
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
	winNetMutex sync.Mutex
	winLastRx   uint64
	winLastTx   uint64
	winLastTime time.Time
)

func getWindowsNetwork() NetworkData {
	out, err := exec.Command("netstat", "-e").Output()
	if err != nil {
		return NetworkData{}
	}
	var rxBytes, txBytes uint64
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToLower(line), "bytes") {
			fields := strings.Fields(line)
			if len(fields) >= 3 {
				rxBytes, _ = strconv.ParseUint(fields[1], 10, 64)
				txBytes, _ = strconv.ParseUint(fields[2], 10, 64)
			}
			break
		}
	}

	winNetMutex.Lock()
	defer winNetMutex.Unlock()

	now := time.Now()
	var rxSpeed, txSpeed float64
	if !winLastTime.IsZero() && now.Sub(winLastTime) > 0 {
		durationSec := now.Sub(winLastTime).Seconds()
		if rxBytes >= winLastRx {
			rxSpeed = float64(rxBytes-winLastRx) / 1024.0 / durationSec
		}
		if txBytes >= winLastTx {
			txSpeed = float64(txBytes-winLastTx) / 1024.0 / durationSec
		}
	}
	winLastRx = rxBytes
	winLastTx = txBytes
	winLastTime = now

	return NetworkData{
		RxBytes: rxBytes,
		TxBytes: txBytes,
		RxSpeed: rxSpeed,
		TxSpeed: txSpeed,
	}
}

func PushMetricsToES(config *Config, metrics *Metrics) {
	if config.WindowsEventPush == nil || !config.WindowsEventPush.ElasticsearchEnabled || !config.WindowsEventPush.MetricsEnabled || config.WindowsEventPush.URL == "" {
		return
	}

	hostname, _ := os.Hostname()

	// Flatten to ECS
	payload := make(map[string]interface{})
	payload["@timestamp"] = time.Now().UTC().Format(time.RFC3339)
	payload["event.dataset"] = "system.metrics"
	payload["host.name"] = hostname

	if metrics.CPU != nil {
		payload["system.cpu.total.norm.pct"] = metrics.CPU.Used / 100.0
	}
	if metrics.Memory != nil {
		payload["system.memory.used.pct"] = metrics.Memory.Used / 100.0
		payload["system.memory.total"] = metrics.Memory.TotalMB * 1024 * 1024
	}
	for _, d := range metrics.Disk {
		cleanMount := strings.ReplaceAll(d.Mount, "\\", "")
		cleanMount = strings.ReplaceAll(cleanMount, ":", "")
		payload[fmt.Sprintf("system.filesystem.%s.used.pct", cleanMount)] = d.Used / 100.0
	}
	
	// Services & Processes (ECS extension or custom)
	for _, s := range metrics.Services {
		payload[fmt.Sprintf("service.%s.state", s.Name)] = s.Status
	}
	for _, p := range metrics.Processes {
		payload[fmt.Sprintf("process.%s.state", p.Name)] = p.Status
	}

	// Index formatting
	indexName := config.WindowsEventPush.MetricsIndexName
	if indexName == "" {
		indexName = "vanguard-metrics"
	}
	indexName = strings.ReplaceAll(indexName, "%Y", time.Now().Format("2006"))
	indexName = strings.ReplaceAll(indexName, "%m", time.Now().Format("01"))
	indexName = strings.ReplaceAll(indexName, "%d", time.Now().Format("02"))

	doc, _ := json.Marshal(payload)
	
	// Bulk request
	meta := fmt.Sprintf(`{"index":{"_index":"%s"}}`+"\n", indexName)
	var bulkBody []byte
	bulkBody = append(bulkBody, []byte(meta)...)
	bulkBody = append(bulkBody, doc...)
	bulkBody = append(bulkBody, '\n')

	client := getESHTTPClient(15 * time.Second)
	req, err := http.NewRequest("POST", config.WindowsEventPush.URL+"/_bulk", bytes.NewBuffer(bulkBody))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if config.WindowsEventPush.Username != "" {
		req.SetBasicAuth(config.WindowsEventPush.Username, config.WindowsEventPush.Password)
	}

	resp, err := client.Do(req)
	if err != nil {
		log.Println("[ES Metrics] Push failed:", err)
		return
	}
	defer resp.Body.Close()
	
	if resp.StatusCode >= 400 {
		log.Println("[ES Metrics] Push error, HTTP:", resp.StatusCode)
	}
}
