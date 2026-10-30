package main

import (
	"fmt"
	"log"
	"gopkg.in/yaml.v3"
	"strings"
)

type YamlRule struct {
	Channel      string   `yaml:"channel"`
	Level        string   `yaml:"level"`
	Tags         []string `yaml:"tags"`
	ExcludeUsers []string `yaml:"exclude_users"`
	EventIDs     struct {
		Include []int `yaml:"include"`
		Exclude []int `yaml:"exclude"`
	} `yaml:"event_ids"`
}

type YamlPolicy struct {
	ScoutPushPolicy []YamlRule `yaml:"scout_push_policy"`
}

func parseYamlPolicy(yamlStr string) ([]YamlRule, error) {
	var policy YamlPolicy
	err := yaml.Unmarshal([]byte(yamlStr), &policy)
	if err != nil {
		return nil, err
	}
	return policy.ScoutPushPolicy, nil
}

// EvaluatePushPolicy checks if the event matches any rule in the YAML policy.
// Returns match (bool) and tags ([]string) to append.
func EvaluatePushPolicy(ev map[string]interface{}, rules []YamlRule) (bool, []string) {
	channel, _ := ev["logName"].(string)
	
	// Handle float64/int casting for EventID since json unmarshal can yield float64
	eventIDInt := -1
	switch v := ev["eventID"].(type) {
	case float64:
		eventIDInt = int(v)
	case int:
		eventIDInt = v
	case uint32:
		eventIDInt = int(v)
	case uint16:
		eventIDInt = int(v)
	case string:
		v = strings.TrimSpace(v)
		fmt.Sscanf(v, "%d", &eventIDInt)
	}
	
	levelStr, _ := ev["level"].(string)
	
	for _, rule := range rules {
		// Check channel
		if rule.Channel != "" && !strings.EqualFold(rule.Channel, channel) {
			continue
		}
		
		// Check EventIDs (Include)
		if len(rule.EventIDs.Include) > 0 && eventIDInt != -1 {
			included := false
			for _, inc := range rule.EventIDs.Include {
				if inc == eventIDInt {
					included = true
					break
				}
			}
			if !included {
				continue
			}
		}
		
		// Check EventIDs (Exclude)
		if len(rule.EventIDs.Exclude) > 0 && eventIDInt != -1 {
			excluded := false
			for _, exc := range rule.EventIDs.Exclude {
				if exc == eventIDInt {
					excluded = true
					break
				}
			}
			if excluded {
				continue
			}
		}

		// Check ExcludeUsers (e.g. backup, healthcheck)
		if len(rule.ExcludeUsers) > 0 {
			rawStr, _ := ev["raw"].(string)
			msgStr, _ := ev["message"].(string)
			combined := strings.ToLower(rawStr + " " + msgStr)
			excludedUser := false
			for _, exUser := range rule.ExcludeUsers {
				exTrim := strings.TrimSpace(exUser)
				if exTrim == "" {
					continue
				}
				exBase := exTrim
				if idx := strings.LastIndex(exTrim, "\\"); idx != -1 {
					exBase = exTrim[idx+1:]
				}
				if strings.Contains(combined, strings.ToLower(exTrim)) || strings.Contains(combined, strings.ToLower(exBase)) {
					excludedUser = true
					break
				}
			}
			if excludedUser {
				continue
			}
		}
		
		// Check Level (tolerant to All, All Levels, Warning & Above, Error & Critical)
		if rule.Level != "" {
			normLvl := strings.TrimSpace(rule.Level)
			low := strings.ToLower(normLvl)
			if !strings.EqualFold(normLvl, "All") && !strings.EqualFold(normLvl, "All Levels") && low != "all" {
				matchLvl := false
				if strings.HasPrefix(low, "error") || strings.HasPrefix(low, "critical") {
					if levelStr == "1" || levelStr == "2" {
						matchLvl = true
					}
				} else if strings.HasPrefix(low, "warn") {
					if levelStr == "1" || levelStr == "2" || levelStr == "3" {
						matchLvl = true
					}
				} else if strings.HasPrefix(low, "info") {
					if levelStr == "0" || levelStr == "1" || levelStr == "2" || levelStr == "3" || levelStr == "4" || levelStr == "" {
						matchLvl = true
					}
				}
				if !matchLvl {
					continue
				}
			}
		}
		
		// If we passed all checks, it's a match!
		log.Printf("[ES] Event matched YAML rule: Channel=%s, EventID=%d\n", channel, eventIDInt)
		return true, rule.Tags
	}
	
	// log.Printf("[ES] Event did NOT match YAML rules: Channel=%s, EventID=%d\n", channel, eventIDInt)
	return false, nil
}
