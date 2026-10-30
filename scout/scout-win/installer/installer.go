package main

import (
	"embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

//go:embed payload/*
var payload embed.FS

func killExistingProcesses() {
	// Force kill any running scout-agent.exe, scout.exe, or legacy scout-win.exe instances
	exec.Command("taskkill", "/F", "/IM", "scout-agent.exe", "/T").Run()
	exec.Command("taskkill", "/F", "/IM", "scout.exe", "/T").Run()
	exec.Command("taskkill", "/F", "/IM", "scout-win.exe", "/T").Run()
	// Unregister any legacy scheduled tasks to prevent duplicate background execution
	exec.Command("schtasks", "/Delete", "/TN", "ScoutMonitorAgent", "/F").Run()
	time.Sleep(1 * time.Second)
}

func main() {
	fmt.Println("Scout-Win Installer & Updater")
	fmt.Println("=============================")

	targetDir := filepath.Join(os.Getenv("ProgramFiles"), "scout-win")
	fmt.Printf("Target Directory: %s\n", targetDir)

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		fmt.Printf("Failed to create target directory (Run as Admin?): %v\n", err)
		os.Exit(1)
	}

	scoutExe := filepath.Join(targetDir, "scout.exe")

	// 1. Stop and uninstall existing Windows Service if exists
	if _, err := os.Stat(scoutExe); err == nil {
		fmt.Println("Stopping and uninstalling existing service...")
		exec.Command("net", "stop", "ScoutAgent").Run()
		exec.Command(scoutExe, "stop").Run()
		exec.Command(scoutExe, "uninstall").Run()
	}

	// 2. Kill all remaining/orphaned processes to prevent file locks or duplicate processes
	fmt.Println("Ensuring no orphaned scout-agent processes remain...")
	killExistingProcesses()

	// Clean up legacy scout-win.exe file if present
	legacyFile := filepath.Join(targetDir, "scout-win.exe")
	if _, err := os.Stat(legacyFile); err == nil {
		os.Remove(legacyFile)
	}

	// 3. Extract files
	files, err := payload.ReadDir("payload")
	if err != nil {
		fmt.Println("Failed to read embedded payload:", err)
		os.Exit(1)
	}

	for _, f := range files {
		content, err := payload.ReadFile("payload/" + f.Name())
		if err != nil {
			fmt.Println("Error reading", f.Name(), err)
			continue
		}

		targetFile := filepath.Join(targetDir, f.Name())

		// Do not overwrite config.json if it exists (preserve user config)
		if f.Name() == "config.json" {
			if _, err := os.Stat(targetFile); err == nil {
				fmt.Println("Skipping config.json (already exists)")
				continue
			}
		}

		// Try writing file, retry with kill if locked
		err = os.WriteFile(targetFile, content, 0755)
		if err != nil {
			killExistingProcesses()
			err = os.WriteFile(targetFile, content, 0755)
		}

		if err != nil {
			fmt.Printf("Error writing %s: %v\n", f.Name(), err)
		} else {
			fmt.Printf("Extracted %s\n", f.Name())
		}
	}

	// 4. Install and Start Service
	fmt.Println("Installing Windows Service...")
	installCmd := exec.Command(scoutExe, "install")
	installCmd.Dir = targetDir
	if out, err := installCmd.CombinedOutput(); err != nil {
		fmt.Printf("Install error: %v\n%s\n", err, out)
	}

	fmt.Println("Starting Windows Service...")
	startCmd := exec.Command(scoutExe, "start")
	startCmd.Dir = targetDir
	if out, err := startCmd.CombinedOutput(); err != nil {
		fmt.Printf("Start error: %v\n%s\n", err, out)
	} else {
		fmt.Println("Service started successfully!")
	}

	// Check for silent flag
	isSilent := false
	for _, arg := range os.Args[1:] {
		if arg == "-silent" || arg == "-s" || arg == "-y" || arg == "/quiet" || arg == "/s" {
			isSilent = true
			break
		}
	}

	if !isSilent {
		fmt.Println("\nInstallation & Update Complete!")
		fmt.Println("Press Enter to exit...")
		fmt.Scanln()
	}
}
