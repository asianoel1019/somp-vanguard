package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	modwevtapi = syscall.NewLazyDLL("wevtapi.dll")

	procEvtQuery                = modwevtapi.NewProc("EvtQuery")
	procEvtNext                 = modwevtapi.NewProc("EvtNext")
	procEvtClose                = modwevtapi.NewProc("EvtClose")
	procEvtRender               = modwevtapi.NewProc("EvtRender")
	procEvtOpenPublisherMetadata = modwevtapi.NewProc("EvtOpenPublisherMetadata")
	procEvtFormatMessage         = modwevtapi.NewProc("EvtFormatMessage")
)

const (
	EvtQueryChannelPath      = 1
	EvtQueryForwardDirection = 0x100
	EvtRenderEventXml        = 1
	EvtFormatMessageEvent    = 1
)

type ExtractedEvent struct {
	RawXML  string
	Message string
}

func buildXmlQuery(logName string, lastRecordId int64) string {
	var xpath string
	if lastRecordId > 0 {
		xpath = fmt.Sprintf("EventRecordID > %d", lastRecordId)
	}
	
	var selectStr string
	if xpath != "" {
		selectStr = fmt.Sprintf("*[System[%s]]", xpath)
	} else {
		selectStr = "*"
	}
	
	return fmt.Sprintf(`<QueryList><Query Id="0" Path="%s"><Select Path="%s">%s</Select></Query></QueryList>`, logName, logName, selectStr)
}

func utf16PtrFromString(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

// formatEventDataSummary builds a clean key-value summary from EventData if EvtFormatMessage is unavailable
func formatEventDataSummary(parsed *EventXML) string {
	if len(parsed.EventData.Data) > 0 {
		var parts []string
		for _, d := range parsed.EventData.Data {
			val := strings.TrimSpace(d.Value)
			if val != "" {
				if d.Name != "" {
					parts = append(parts, fmt.Sprintf("%s: %s", d.Name, val))
				} else {
					parts = append(parts, val)
				}
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "; ")
		}
	}
	return fmt.Sprintf("EventID %s from %s (Channel: %s)", parsed.System.EventID, parsed.System.Provider.Name, parsed.System.Channel)
}

// renderEventMessage resolves formatted message text using wevtapi.dll EvtFormatMessage, with EventData fallback
func renderEventMessage(eventHandle syscall.Handle, providerName string, parsed *EventXML) string {
	if providerName != "" {
		pNamePtr := utf16PtrFromString(providerName)
		hMeta, _, _ := procEvtOpenPublisherMetadata.Call(0, uintptr(unsafe.Pointer(pNamePtr)), 0, 0, 0)
		if hMeta != 0 {
			defer procEvtClose.Call(hMeta)
			var bufferUsed uint32
			procEvtFormatMessage.Call(
				hMeta,
				uintptr(eventHandle),
				0,
				0,
				0,
				uintptr(EvtFormatMessageEvent),
				0,
				0,
				uintptr(unsafe.Pointer(&bufferUsed)),
			)
			if bufferUsed > 0 {
				buf := make([]uint16, bufferUsed)
				r1, _, _ := procEvtFormatMessage.Call(
					hMeta,
					uintptr(eventHandle),
					0,
					0,
					0,
					uintptr(EvtFormatMessageEvent),
					uintptr(bufferUsed),
					uintptr(unsafe.Pointer(&buf[0])),
					uintptr(unsafe.Pointer(&bufferUsed)),
				)
				if r1 != 0 {
					msg := strings.TrimSpace(syscall.UTF16ToString(buf))
					if msg != "" {
						return msg
					}
				}
			}
		}
	}
	return formatEventDataSummary(parsed)
}

func fetchNewEvents(logName string, lastRecordId int64) []ExtractedEvent {
	xmlQuery := buildXmlQuery(logName, lastRecordId)
	queryPtr := utf16PtrFromString(xmlQuery)
	
	// 1 = EvtQueryChannelPath, 0x100 = EvtQueryForwardDirection
	r1, _, err := procEvtQuery.Call(
		0,
		0,
		uintptr(unsafe.Pointer(queryPtr)),
		uintptr(1|0x100),
	)
	
	handle := syscall.Handle(r1)
	if handle == 0 {
		log.Printf("[EventLog] EvtQuery failed for %s. Err: %v\n", logName, err)
		return nil
	}
	defer procEvtClose.Call(uintptr(handle))

	var events []ExtractedEvent
	
	for {
		var eventHandle syscall.Handle
		var returned uint32

		r1, _, err := procEvtNext.Call(
			uintptr(handle),
			1,
			uintptr(unsafe.Pointer(&eventHandle)),
			2000,
			0,
			uintptr(unsafe.Pointer(&returned)),
		)

		if r1 == 0 || returned == 0 {
			if r1 == 0 {
				errCode := err.(syscall.Errno)
				if errCode != 259 && errCode != 1460 { // 259=ERROR_NO_MORE_ITEMS, 1460=ERROR_TIMEOUT
					log.Printf("[EventLog] EvtNext failed for %s. Err: %v\n", logName, err)
				}
			}
			break 
		}

		// Render event
		var bufferUsed uint32
		var propertyCount uint32
		
		procEvtRender.Call(
			0,
			uintptr(eventHandle),
			uintptr(EvtRenderEventXml),
			0,
			0,
			uintptr(unsafe.Pointer(&bufferUsed)),
			uintptr(unsafe.Pointer(&propertyCount)),
		)
		
		if bufferUsed > 0 {
			buf := make([]uint16, bufferUsed/2)
			r1, _, _ = procEvtRender.Call(
				0,
				uintptr(eventHandle),
				uintptr(EvtRenderEventXml),
				uintptr(bufferUsed),
				uintptr(unsafe.Pointer(&buf[0])),
				uintptr(unsafe.Pointer(&bufferUsed)),
				uintptr(unsafe.Pointer(&propertyCount)),
			)
			if r1 != 0 {
				rawXML := syscall.UTF16ToString(buf)
				
				// Fast extraction of EventRecordID to check if we should stop
				var parsed EventXML
				if err := xml.Unmarshal([]byte(rawXML), &parsed); err == nil {
					recID := int64(0)
					fmt.Sscanf(parsed.System.EventRecordID, "%d", &recID)
					
					if recID <= lastRecordId {
						procEvtClose.Call(uintptr(eventHandle))
						return events // Reached the old events! STOP!
					}

					msg := renderEventMessage(eventHandle, parsed.System.Provider.Name, &parsed)
					events = append(events, ExtractedEvent{
						RawXML:  rawXML,
						Message: msg,
					})
				}
			}
		}
		
		procEvtClose.Call(uintptr(eventHandle))
		
		// Break if we fetch too many at once to avoid blocking
		if len(events) >= 100 {
			break
		}
	}
	
	return events
}

type EventXML struct {
	System struct {
		Provider struct {
			Name string `xml:"Name,attr"`
		} `xml:"Provider"`
		EventID     string `xml:"EventID"`
		Level       string `xml:"Level"`
		TimeCreated struct {
			SystemTime string `xml:"SystemTime,attr"`
		} `xml:"TimeCreated"`
		EventRecordID string `xml:"EventRecordID"`
		Computer      string `xml:"Computer"`
		Channel       string `xml:"Channel"`
	} `xml:"System"`
	EventData struct {
		Data []struct {
			Name  string `xml:"Name,attr"`
			Value string `xml:",chardata"`
		} `xml:"Data"`
	} `xml:"EventData"`
}

func getLatestEventRecordID(logName string) int64 {
	xmlQ := fmt.Sprintf(`<QueryList><Query Id="0" Path="%s"><Select Path="%s">*</Select></Query></QueryList>`, logName, logName)
	queryPtr := utf16PtrFromString(xmlQ)
	// 0x200 = EvtQueryReverseDirection
	r1, _, _ := procEvtQuery.Call(0, 0, uintptr(unsafe.Pointer(queryPtr)), uintptr(EvtQueryChannelPath|0x200))
	handle := syscall.Handle(r1)
	if handle == 0 {
		return 0
	}
	defer procEvtClose.Call(uintptr(handle))

	var eventHandle syscall.Handle
	var returned uint32
	r1, _, _ = procEvtNext.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&eventHandle)), 2000, 0, uintptr(unsafe.Pointer(&returned)))
	if r1 == 0 || returned == 0 {
		return 0
	}
	defer procEvtClose.Call(uintptr(eventHandle))

	var bufferUsed uint32
	var propertyCount uint32
	procEvtRender.Call(0, uintptr(eventHandle), uintptr(EvtRenderEventXml), 0, 0, uintptr(unsafe.Pointer(&bufferUsed)), uintptr(unsafe.Pointer(&propertyCount)))
	if bufferUsed > 0 {
		buf := make([]uint16, bufferUsed/2)
		procEvtRender.Call(0, uintptr(eventHandle), uintptr(EvtRenderEventXml), uintptr(bufferUsed), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bufferUsed)), uintptr(unsafe.Pointer(&propertyCount)))
		var parsed EventXML
		if err := xml.Unmarshal([]byte(syscall.UTF16ToString(buf)), &parsed); err == nil {
			var recID int64
			fmt.Sscanf(parsed.System.EventRecordID, "%d", &recID)
			return recID
		}
	}
	return 0
}

func EventLoop(config *Config) {
	var lastRecordIds = make(map[string]int64)
	
	for {
		time.Sleep(10 * time.Second)
		
		ConfigMutex.RLock()
		policyCopy := append([]WindowsEventRule(nil), config.WindowsEventPolicy...)
		ConfigMutex.RUnlock()

		if len(policyCopy) == 0 {
			continue
		}
		
		var payload []map[string]interface{}
		hostname, _ := os.Hostname()
		
		for _, policy := range policyCopy {
			logName := policy.LogName
			if logName == "" {
				continue
			}
			
			if lastRecordIds[logName] == 0 {
				latestId := getLatestEventRecordID(logName)
				log.Printf("[EventLog] Initialized lastRecordId for %s: %d\n", logName, latestId)
				lastRecordIds[logName] = latestId
			}
			
			rawEvents := fetchNewEvents(logName, lastRecordIds[logName])
			if len(rawEvents) > 0 {
				log.Printf("[EventLog] fetchNewEvents fetched %d raw events for %s\n", len(rawEvents), logName)
			}
			
			for _, evtItem := range rawEvents {
				var parsed EventXML
				if err := xml.Unmarshal([]byte(evtItem.RawXML), &parsed); err == nil {
					recID := int64(0)
					fmt.Sscanf(parsed.System.EventRecordID, "%d", &recID)
					
					if recID > lastRecordIds[parsed.System.Channel] {
						lastRecordIds[parsed.System.Channel] = recID
					}

					// Filter by ExcludeIds
					if policy.ExcludeIds != "" {
						exclude := false
						ids := strings.Split(policy.ExcludeIds, ",")
						for _, id := range ids {
							if strings.TrimSpace(id) == parsed.System.EventID {
								exclude = true
								break
							}
						}
						if exclude {
							continue
						}
					}

					// Filter by ExcludeUsers (e.g. service accounts, backup users)
					if policy.ExcludeUsers != "" {
						excludeUser := false
						excludedList := strings.Split(policy.ExcludeUsers, ",")
						for _, dataItem := range parsed.EventData.Data {
							nameLower := strings.ToLower(dataItem.Name)
							if strings.Contains(nameLower, "username") || nameLower == "user" || nameLower == "samaccountname" || nameLower == "accountname" {
								valTrim := strings.TrimSpace(dataItem.Value)
								if valTrim == "" || valTrim == "-" {
									continue
								}
								baseVal := valTrim
								if idx := strings.LastIndex(valTrim, "\\"); idx != -1 {
									baseVal = valTrim[idx+1:]
								}
								for _, ex := range excludedList {
									exTrim := strings.TrimSpace(ex)
									if exTrim == "" {
										continue
									}
									exBase := exTrim
									if idx := strings.LastIndex(exTrim, "\\"); idx != -1 {
										exBase = exTrim[idx+1:]
									}
									if strings.EqualFold(exTrim, valTrim) || strings.EqualFold(exBase, baseVal) || strings.EqualFold(exTrim, baseVal) {
										excludeUser = true
										break
									}
								}
								if excludeUser {
									break
								}
							}
						}
						if excludeUser {
							continue
						}
					}

					// Filter by IncludeIds
					if policy.IncludeIds != "" {
						include := false
						ids := strings.Split(policy.IncludeIds, ",")
						for _, id := range ids {
							if strings.TrimSpace(id) == parsed.System.EventID {
								include = true
								break
							}
						}
						if !include {
							continue
						}
					}

					// Filter by Severity
					if policy.Severity != "" && policy.Severity != "All" {
						level := parsed.System.Level
						match := false
						if policy.Severity == "Critical" && level == "1" {
							match = true
						} else if policy.Severity == "Error" && (level == "1" || level == "2") {
							match = true
						} else if policy.Severity == "Warning" && (level == "1" || level == "2" || level == "3") {
							match = true
						} else if policy.Severity == "Information" && (level == "0" || level == "1" || level == "2" || level == "3" || level == "4" || level == "") {
							match = true
						}
						if !match {
							continue
						}
					}
					
					rawJSONBytes, _ := json.Marshal(parsed)
					rawJSON := string(rawJSONBytes)
					
					payload = append(payload, map[string]interface{}{
						"logName":   parsed.System.Channel,
						"eventID":   parsed.System.EventID,
						"level":     parsed.System.Level,
						"provider":  parsed.System.Provider.Name,
						"timestamp": parsed.System.TimeCreated.SystemTime,
						"message":   evtItem.Message,
						"raw":       rawJSON,
					})
				}
			}
		}

		if len(payload) > 0 {
			debugLine := fmt.Sprintf("[%s] Caught %d events\n", time.Now().Format(time.RFC3339), len(payload))
			for _, evt := range payload {
				debugLine += fmt.Sprintf("  - EventID: %v, Level: %v\n", evt["eventID"], evt["level"])
			}
			if f, err := os.OpenFile("event_debug.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
				f.WriteString(debugLine)
				f.Close()
			}

			ConfigMutex.RLock()
			apiKey := config.APIKey
			backendUrl := config.BackendURL
			ConfigMutex.RUnlock()
			
			data, _ := json.Marshal(map[string]interface{}{
				"apiKey":   apiKey,
				"hostname": hostname,
				"events":   payload,
			})
			client := getHTTPClient(15 * time.Second)
			ConfigMutex.RLock()
			tlsEnabled := config.TlsEnabled
			ConfigMutex.RUnlock()
			if tlsEnabled && strings.HasPrefix(backendUrl, "http://") {
				backendUrl = "https://" + strings.TrimPrefix(backendUrl, "http://")
			}
			resp, reqErr := client.Post(backendUrl+"/api/monitor/event", "application/json", bytes.NewBuffer(data))
			if reqErr == nil {
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}
	}
}

func ESPushLoop(config *Config) {
	esLastRecordIds := make(map[string]int64)

	for {
		time.Sleep(10 * time.Second)
		ConfigMutex.RLock()
		pushPolicy := config.WindowsEventPush
		ConfigMutex.RUnlock()

		if pushPolicy == nil || !pushPolicy.ElasticsearchEnabled || !pushPolicy.LogEnabled || pushPolicy.URL == "" {
			continue
		}
		
		rules, err := parseYamlPolicy(pushPolicy.YamlConfig)
		if err != nil || len(rules) == 0 {
			continue
		}
		
		channels := make(map[string]bool)
		for _, rule := range rules {
			if rule.Channel != "" {
				channels[rule.Channel] = true
			}
		}
		
		var rawPayload []map[string]interface{}
		
		for channel := range channels {
			if esLastRecordIds[channel] == 0 {
				esLastRecordIds[channel] = getLatestEventRecordID(channel)
			}
			
			rawEvents := fetchNewEvents(channel, esLastRecordIds[channel])
			for _, evtItem := range rawEvents {
				var parsed EventXML
				if err := xml.Unmarshal([]byte(evtItem.RawXML), &parsed); err == nil {
					var recID int64
					fmt.Sscanf(parsed.System.EventRecordID, "%d", &recID)
					if recID > esLastRecordIds[channel] {
						esLastRecordIds[channel] = recID
					}
					rawJSONBytes, _ := json.Marshal(parsed)
					rawPayload = append(rawPayload, map[string]interface{}{
						"logName":   parsed.System.Channel,
						"eventID":   parsed.System.EventID,
						"level":     parsed.System.Level,
						"provider":  parsed.System.Provider.Name,
						"timestamp": parsed.System.TimeCreated.SystemTime,
						"computer":  parsed.System.Computer,
						"recordID":  recID,
						"message":   evtItem.Message,
						"raw":       string(rawJSONBytes),
					})
				}
			}
		}
		
		if len(rawPayload) > 0 {
			go pushToES(pushPolicy, rawPayload)
		}
	}
}

// Helper to determine primary local IP for ECS host mapping
func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	localAddr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || localAddr == nil {
		return "127.0.0.1"
	}
	return localAddr.IP.String()
}

// Ensure EventLoop is called from main

func pushToES(policy *WindowsEventPushPolicy, events []map[string]interface{}) {
	if len(events) == 0 {
		return
	}
	
	rules, err := parseYamlPolicy(policy.YamlConfig)
	if err != nil {
		log.Println("[ES] Failed to parse YAML mapping:", err)
		return
	}
	
	var bulkBody []byte
	indexName := policy.LogIndexName
	if indexName == "" {
		indexName = "scout-agent"
	}
	indexName = strings.ReplaceAll(indexName, "%Y", time.Now().Format("2006"))
	indexName = strings.ReplaceAll(indexName, "%m", time.Now().Format("01"))
	indexName = strings.ReplaceAll(indexName, "%d", time.Now().Format("02"))
	
	matchedCount := 0
	hostname, _ := os.Hostname()
	localIP := getLocalIP()
	
	for _, ev := range events {
		// Evaluate policy
		match, tags := EvaluatePushPolicy(ev, rules)
		if !match {
			continue
		}
		matchedCount++
		
		meta := fmt.Sprintf(`{"index":{"_index":"%s"}}`+"\n", indexName)
		bulkBody = append(bulkBody, []byte(meta)...)
		
		// Create a copy of the event specifically for ES
		esDoc := make(map[string]interface{})
		for k, v := range ev {
			esDoc[k] = v
		}

		var flatData map[string]interface{}
		
		// Convert 'raw' from string to an actual JSON object so Kibana can index the fields
		if rawStr, ok := ev["raw"].(string); ok {
			var rawObj map[string]interface{}
			if err := json.Unmarshal([]byte(rawStr), &rawObj); err == nil {
				// Flatten EventData.Data array into a key-value map for easier ES querying
				if ed, ok := rawObj["EventData"].(map[string]interface{}); ok {
					if dataArr, ok := ed["Data"].([]interface{}); ok {
						flatData = make(map[string]interface{})
						for _, item := range dataArr {
							if itemMap, ok := item.(map[string]interface{}); ok {
								if name, ok := itemMap["Name"].(string); ok && name != "" {
									if value, ok := itemMap["Value"]; ok {
										flatData[name] = value
									}
								}
							}
						}
						ed["Data"] = flatData
					}
				}
				esDoc["raw"] = rawObj // Store as nested JSON object instead of string
			}
		}
		
		if len(tags) > 0 {
			esDoc["tags"] = tags
		}

		// --- 100% Elastic 8/9 Security SIEM & Dashboard ECS Mapping ---
		// 1. Root timestamp & ECS version
		if ts, ok := ev["timestamp"].(string); ok && ts != "" {
			esDoc["@timestamp"] = ts
		} else {
			esDoc["@timestamp"] = time.Now().UTC().Format(time.RFC3339)
		}
		esDoc["ecs"] = map[string]interface{}{"version": "8.11.0"}

		// 2. ECS agent
		esDoc["agent"] = map[string]interface{}{
			"type":    "scout-win",
			"version": "1.2.0",
			"name":    hostname,
		}

		// 3. ECS host
		compName, _ := ev["computer"].(string)
		if compName == "" {
			compName = hostname
		}
		esDoc["host"] = map[string]interface{}{
			"id":       compName,
			"name":     compName,
			"hostname": compName,
			"ip":       []string{localIP},
			"os": map[string]interface{}{
				"type":     "windows",
				"family":   "windows",
				"platform": "windows",
			},
		}

		// 4. ECS winlog
		var eventIDNum int64
		if evIdStr, ok := ev["eventID"].(string); ok {
			fmt.Sscanf(evIdStr, "%d", &eventIDNum)
		} else if evIdNum, ok := ev["eventID"].(int64); ok {
			eventIDNum = evIdNum
		}
		var recordIDNum int64
		if rId, ok := ev["recordID"].(int64); ok {
			recordIDNum = rId
		}

		winlogMap := map[string]interface{}{
			"channel":       ev["logName"],
			"event_id":      eventIDNum,
			"provider_name": ev["provider"],
			"record_id":     recordIDNum,
			"computer_name": compName,
		}
		if flatData != nil {
			winlogMap["event_data"] = flatData
		}
		esDoc["winlog"] = winlogMap

		// 5. ECS event (Automatic Categorization for Elastic SIEM Detection Rules)
		eventCategory := []string{"host"}
		eventType := []string{"info"}
		eventOutcome := "unknown"
		eventAction := ""
		channelStr, _ := ev["logName"].(string)
		dataset := fmt.Sprintf("windows.%s", strings.ToLower(channelStr))

		switch eventIDNum {
		case 4624: // Successful Logon
			eventCategory = []string{"authentication", "session"}
			eventType = []string{"start"}
			eventOutcome = "success"
			eventAction = "logged-in"
		case 4625: // Failed Logon
			eventCategory = []string{"authentication"}
			eventType = []string{"start"}
			eventOutcome = "failure"
			eventAction = "logon-failed"
		case 4634, 4647: // Logoff
			eventCategory = []string{"authentication", "session"}
			eventType = []string{"end"}
			eventOutcome = "success"
			eventAction = "logged-out"
		case 4672: // Special Privileges Assigned
			eventCategory = []string{"authentication", "iam"}
			eventType = []string{"access"}
			eventOutcome = "success"
			eventAction = "special-privileges-assigned"
		case 4688: // Process Creation
			eventCategory = []string{"process"}
			eventType = []string{"start"}
			eventOutcome = "success"
			eventAction = "process-started"
		case 4689: // Process Exit
			eventCategory = []string{"process"}
			eventType = []string{"end"}
			eventOutcome = "success"
			eventAction = "process-stopped"
		case 4720: // User Created
			eventCategory = []string{"iam"}
			eventType = []string{"user", "creation"}
			eventOutcome = "success"
			eventAction = "user-created"
		case 4722, 4724, 4738: // User Modified / Password Reset
			eventCategory = []string{"iam"}
			eventType = []string{"user", "change"}
			eventOutcome = "success"
			eventAction = "user-modified"
		case 4726: // User Deleted
			eventCategory = []string{"iam"}
			eventType = []string{"user", "deletion"}
			eventOutcome = "success"
			eventAction = "user-deleted"
		case 4728, 4732, 4756: // Member Added to Security Group
			eventCategory = []string{"iam"}
			eventType = []string{"group", "change"}
			eventOutcome = "success"
			eventAction = "group-member-added"
		case 4729, 4733, 4757: // Member Removed from Security Group
			eventCategory = []string{"iam"}
			eventType = []string{"group", "change"}
			eventOutcome = "success"
			eventAction = "group-member-removed"
		case 7045, 4697: // Service Installed
			eventCategory = []string{"process", "configuration"}
			eventType = []string{"creation"}
			eventOutcome = "success"
			eventAction = "service-installed"
		case 1102, 104: // Audit Log Cleared
			eventCategory = []string{"configuration"}
			eventType = []string{"deletion"}
			eventOutcome = "success"
			eventAction = "audit-log-cleared"
		}

		eventMap := map[string]interface{}{
			"code":     fmt.Sprintf("%d", eventIDNum),
			"module":   "windows",
			"dataset":  dataset,
			"provider": ev["provider"],
			"kind":     "event",
			"category": eventCategory,
			"type":     eventType,
			"outcome":  eventOutcome,
		}
		if eventAction != "" {
			eventMap["action"] = eventAction
		}
		esDoc["event"] = eventMap

		// 6. ECS User Mapping
		if flatData != nil {
			if targetUser, ok := flatData["TargetUserName"].(string); ok && targetUser != "" && targetUser != "-" {
				userMap := map[string]interface{}{
					"name": targetUser,
				}
				if targetDomain, ok := flatData["TargetDomainName"].(string); ok && targetDomain != "" && targetDomain != "-" {
					userMap["domain"] = targetDomain
				}
				if targetSid, ok := flatData["TargetUserSid"].(string); ok && targetSid != "" {
					userMap["id"] = targetSid
				}
				esDoc["user"] = userMap
			} else if subjUser, ok := flatData["SubjectUserName"].(string); ok && subjUser != "" && subjUser != "-" {
				userMap := map[string]interface{}{
					"name": subjUser,
				}
				if subjDomain, ok := flatData["SubjectDomainName"].(string); ok && subjDomain != "" && subjDomain != "-" {
					userMap["domain"] = subjDomain
				}
				esDoc["user"] = userMap
			}

			// 7. ECS Source Network Mapping
			if ipStr, ok := flatData["IpAddress"].(string); ok && ipStr != "" && ipStr != "-" && ipStr != "127.0.0.1" && ipStr != "::1" {
				srcMap := map[string]interface{}{
					"ip": ipStr,
				}
				if portStr, ok := flatData["IpPort"].(string); ok && portStr != "" && portStr != "-" && portStr != "0" {
					var pNum int
					if fmt.Sscanf(portStr, "%d", &pNum); pNum > 0 {
						srcMap["port"] = pNum
					}
				}
				esDoc["source"] = srcMap
			}

			// 8. ECS Process Mapping
			procName, _ := flatData["NewProcessName"].(string)
			if procName == "" {
				procName, _ = flatData["ProcessName"].(string)
			}
			if procName != "" && procName != "-" {
				procMap := map[string]interface{}{
					"executable": procName,
					"name":       filepath.Base(procName),
				}
				if cmdLine, ok := flatData["CommandLine"].(string); ok && cmdLine != "" {
					procMap["command_line"] = cmdLine
				}
				if pidStr, ok := flatData["NewProcessId"].(string); ok && pidStr != "" {
					var pidNum int64
					if strings.HasPrefix(pidStr, "0x") || strings.HasPrefix(pidStr, "0X") {
						fmt.Sscanf(pidStr, "0x%x", &pidNum)
					} else {
						fmt.Sscanf(pidStr, "%d", &pidNum)
					}
					if pidNum > 0 {
						procMap["pid"] = pidNum
					}
				}
				esDoc["process"] = procMap
			}

			// 9. ECS Service Mapping
			if sName, ok := flatData["ServiceName"].(string); ok && sName != "" {
				esDoc["service"] = map[string]interface{}{
					"name": sName,
				}
			}
		}
		
		doc, _ := json.Marshal(esDoc)
		bulkBody = append(bulkBody, doc...)
		bulkBody = append(bulkBody, '\n')
	}
	
	if matchedCount == 0 {
		return // Nothing to push
	}
	
	req, err := http.NewRequest("POST", policy.URL+"/_bulk", bytes.NewBuffer(bulkBody))
	if err != nil {
		log.Println("[ES] Failed to create request:", err)
		return
	}
	
	req.Header.Set("Content-Type", "application/x-ndjson")
	if policy.Username != "" {
		req.SetBasicAuth(policy.Username, policy.Password)
	}
	
	client := getESHTTPClient(15 * time.Second)
	resp, err := client.Do(req)
	if err != nil {
		log.Println("[ES] Failed to push events:", err)
		return
	}
	defer resp.Body.Close()
	
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		log.Printf("[ES] Push failed with status %d: %s\n", resp.StatusCode, string(body))
	} else {
		if bytes.Contains(body, []byte(`"errors":true`)) {
			log.Printf("[ES] Push completed but with inner errors: %s\n", string(body))
		} else {
			log.Printf("[ES] Successfully pushed %d events to Elasticsearch\n", len(events))
		}
	}
}
