# =======================================================
# Headless Nutanix VM Auto Provisioning Script (PE API version)
# Compatible with PowerShell 5.1 (Windows Server 2016)
# =======================================================
[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$ParamFile
)

# 0. PowerShell 5.1 SSL/TLS compatibility setup
try {
    Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(
        ServicePoint srvPoint, X509Certificate certificate,
        WebRequest request, int certificateProblem) {
        return true;
    }
}
"@
    [System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
} catch {
    # Loaded already
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($ParamFile) {
    $ParamFile = $ParamFile.Trim().Trim('"').Trim("'")
}

if (-not (Test-Path $ParamFile)) {
    Write-Error "Error: Cannot find parameter file: $ParamFile"
    exit 1
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   VM Provisioning Tool (Prism Element Edition)" -ForegroundColor Cyan
Write-Host "   PowerShell 5.1 Compatible Edition" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

$Params = Get-Content -Raw $ParamFile | ConvertFrom-Json

# Handle multiple PE IPs if comma separated. Use first IP for primary operations.
$PeIpsStr        = $Params.PrismCentralIP
$PrimaryPeIp     = $PeIpsStr.Split(',')[0].Trim()
$BaseUrl         = "https://${PrimaryPeIp}:9440/api/nutanix/v2.0"
$NUser           = $Params.NUser
$NPass           = $Params.NPass
$JoinUser        = $Params.JoinUser
$JoinPass        = $Params.JoinPass
$AllowedADDomain = $Params.AllowedADDomain
$LocalAdminPass  = $Params.LocalAdminPass
$LinuxAdminPass  = $Params.LinuxAdminPass
$BatchList       = $Params.BatchList
$IPSwitchMap     = $Params.IPSwitchMap
$TemplateBUMap   = $Params.TemplateBUMap

$pair = "${NUser}:${NPass}"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pair)
$base64 = [System.Convert]::ToBase64String($bytes)
$NutanixHeaders = @{
    'Accept'        = 'application/json'
    'Authorization' = "Basic $base64"
    'Content-Type'  = 'application/json'
}

Write-Host "Testing Nutanix Prism Element API connection..." -NoNewline
try {
    $null = Invoke-RestMethod -Uri "$BaseUrl/cluster" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
    Write-Host " Connected successfully! [OK]" -ForegroundColor Green
} catch {
    Write-Host " Failed! [ERROR]" -ForegroundColor Red
    Write-Host "   Detail: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "Starting VM provisioning for $($BatchList.Count) targets on Prism Element..." -ForegroundColor Yellow

# Iterate through each VM sequentially or in parallel. In PE, we perform sequential stable cloning.
foreach ($VM in $BatchList) {
    $CurrentName = $VM.Name
    $CurrentIP   = $VM.IP
    $NumCore     = $VM.NumCore
    $MemoryMiB   = $VM.MemoryMiB
    $OS          = $VM.OS
    $RawBU       = $VM.BU
    $DiskPlan    = $VM.DiskInfo

    Write-Host "---------------------------------------------" -ForegroundColor Gray
    Write-Host "Processing VM: [$CurrentName] ($CurrentIP)..." -ForegroundColor Cyan

    # Resolve specific PE destination cluster IP from IPSwitchMap
    $TargetBaseUrl = $BaseUrl
    if ($CurrentIP) {
        $IpParts = $CurrentIP.Split('.')
        if ($IpParts.Count -eq 4) {
            $SubnetPrefix = "$($IpParts[0]).$($IpParts[1]).$($IpParts[2])"
            $MatchedSubnet = $IPSwitchMap | Where-Object { $_.subnetPrefix -eq $SubnetPrefix }
            if ($MatchedSubnet -and $MatchedSubnet.clusterIp) {
                $TargetPeIp = $MatchedSubnet.clusterIp.Trim()
                if (-not [string]::IsNullOrEmpty($TargetPeIp)) {
                    $TargetBaseUrl = "https://${TargetPeIp}:9440/api/nutanix/v2.0"
                    Write-Host "Routing VM [$CurrentName] deployment to Cluster IP: [$TargetPeIp]" -ForegroundColor Yellow
                }
            }
        }
    }

    # Determine if target OS is Windows or Linux
    $IsWinOS = $true
    if ($OS -match "Linux" -or $OS -match "Ubuntu" -or $OS -match "CentOS" -or $OS -match "RHEL" -or $OS -match "RedHat" -or $OS -match "Debian" -or $OS -match "Rocky" -or $OS -match "Alma" -or $OS -match "SUSE" -or $OS -match "SLES") {
        $IsWinOS = $false
    }

    # Dynamic Template selection logic from TemplateBUMap configuration
    $BUMap = @{
        "188Asia"="188"; "B2B"="B2B"; "BI"="BI"; "CSP-TA"="CSP-TA";
        "INFRA-APP"="APP"; "INFRA-CEM"="CEM"; "INFRA-DBA"="DBA"; "INFRA-NET"="NET";
        "INFRA-OPS"="OPS"; "INFRA-CWD"="CWD"; "INFRA-SYS"="SYS"; "INFRA-TS"="SEC";
        "NBG"="NBG"; "OFC"="OFC"; "SBK"="SBK"; "TRS"="TRS"; "TRS-TW"="TRS-TW"
    }
    $FinalBU = if ($BUMap.ContainsKey($RawBU)) { $BUMap[$RawBU] } else { $RawBU }

    # Parse IP Gateway and Hostname
    $IPParts = $CurrentIP.Split('.')
    if ($IPParts.Count -ne 4) {
        Write-Host "Error: Invalid IP address format: $CurrentIP" -ForegroundColor Red
        exit 1
    }
    $cprIPPre = "$($IPParts[0]).$($IPParts[1]).$($IPParts[2])"
    $CurrentGateway = "$cprIPPre.254"
    $SafeHostname = if ($IsWinOS -and $CurrentName.Length -gt 15) { $CurrentName.Substring(0, 15) } else { $CurrentName }

    # Search for subnet in IP Switch Map
    $Matched = $IPSwitchMap | Where-Object { $_.subnetPrefix -eq $cprIPPre }
    if ($null -eq $Matched) {
        Write-Host "Error: Cannot resolve subnet prefix ($cprIPPre) in IP Switch Map! Skipping..." -ForegroundColor Red
        exit 1
    }

    $LoopZone    = $Matched.zone
    # Domain of the join account: the configured AD domain (ALLOWED_AD_DOMAIN), else the VM's zone
    $JoinCredDomain = if ($AllowedADDomain) { $AllowedADDomain } else { $LoopZone }
    $LoopDns1    = $Matched.dns1
    $LoopDns2    = $Matched.dns2
    $LoopVlan    = $Matched.vlan

    # Template matching
    $TargetTemplateName = ""
    if ($TemplateBUMap) {
        $MatchedMapping = $TemplateBUMap | Where-Object { ($OS -match $_.os) -and ($FinalBU -eq $_.bu) }
        if (-not $MatchedMapping) {
            $MatchedMapping = $TemplateBUMap | Where-Object { ($OS -match $_.os) -and ($_.bu -eq "Default" -or $_.bu -eq "All" -or [string]::IsNullOrEmpty($_.bu)) }
        }
        if ($MatchedMapping) {
            $TargetTemplateName = $MatchedMapping[0].template
        }
    }

    if ([string]::IsNullOrEmpty($TargetTemplateName)) {
        Write-Host "Error: No matching template found for OS [$OS] and BU [$FinalBU]!" -ForegroundColor Red
        exit 1
    }

    Write-Host "Selected template VM name: [$TargetTemplateName]"

    # Sysprep / Cloud-Init Customization Specs Generation (PE v2.0 expects raw plain text XML/userdata)
    $XmlContent = ""
    $CloudContentUnix = ""

    if ($IsWinOS) {
        $XmlContent = @"
<?xml version="1.0" encoding="UTF-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
   <settings pass="specialize">
      <component xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
         <ComputerName>$SafeHostname</ComputerName>
         <RegisteredOwner>Acropolis</RegisteredOwner>
         <TimeZone>SA Western Standard Time</TimeZone>
      </component>
      <component xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="Microsoft-Windows-UnattendedJoin" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
           <Identification>
               <Credentials>
                   <Domain>$JoinCredDomain</Domain>
                   <Password>$JoinPass</Password>
                   <Username>$JoinUser</Username>
               </Credentials>
               <JoinDomain>$LoopZone</JoinDomain>
           </Identification>
      </component>
      <component xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="Microsoft-Windows-TCPIP" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
         <Interfaces>
            <Interface wcm:action="add">
               <Identifier>Ethernet</Identifier>
               <Ipv4Settings><DhcpEnabled>false</DhcpEnabled></Ipv4Settings>
               <UnicastIpAddresses><IpAddress wcm:action="add" wcm:keyValue="1">$CurrentIP/24</IpAddress></UnicastIpAddresses>
               <Routes><Route wcm:action="add"><Identifier>10</Identifier><Metric>24</Metric><NextHopAddress>$CurrentGateway</NextHopAddress><Prefix>0.0.0.0/0</Prefix></Route></Routes>
            </Interface>
         </Interfaces>
      </component>
      <component xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="Microsoft-Windows-DNS-Client" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
         <Interfaces>
            <Interface wcm:action="add">
               <Identifier>Ethernet</Identifier>
               <DNSServerSearchOrder>
                  <IpAddress wcm:action="add" wcm:keyValue="1">$LoopDns1</IpAddress>
                  <IpAddress wcm:action="add" wcm:keyValue="2">$LoopDns2</IpAddress>
               </DNSServerSearchOrder>
            </Interface>
         </Interfaces>
      </component>
   </settings>
   <settings pass="oobeSystem">
      <component xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
         <OOBE>
            <HideEULAPage>true</HideEULAPage>
            <SkipMachineOOBE>true</SkipMachineOOBE>
            <SkipUserOOBE>true</SkipUserOOBE>
         </OOBE>
         <AutoLogon>
            <Password><Value>$LocalAdminPass</Value><PlainText>true</PlainText></Password>
            <Username>Administrator</Username>
            <Enabled>true</Enabled>
            <LogonCount>1</LogonCount>
         </AutoLogon>
         <FirstLogonCommands>
            <SynchronousCommand wcm:action="add">
               <Order>1</Order>
               <Description>Delete Unattend XML</Description>
               <CommandLine>cmd /c del /F /Q C:\Windows\Panther\unattend.xml</CommandLine>
            </SynchronousCommand>
         </FirstLogonCommands>
      </component>
       <component xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
         <InputLocale>en-US</InputLocale>
         <SystemLocale>en-US</SystemLocale>
         <UILanguageFallback>en-us</UILanguageFallback>
         <UILanguage>en-US</UILanguage>
         <UserLocale>en-US</UserLocale>
      </component>
   </settings>
</unattend>
"@
    } else {
        Write-Host "   Configuring Cloud-Init setup for Linux VM..."
        $CloudContent = @"
#cloud-config
hostname: $SafeHostname
runcmd:
  - |
    set +e

    # 1. Detect first ethernet interface
    IFACE=`$(ls /sys/class/net | grep -v lo | head -n 1)
    if [ -z "`$IFACE" ]; then
        IFACE="eth0"
    fi

    # 2. Hostname Setup
    hostnamectl set-hostname "$SafeHostname" || true
    echo "$SafeHostname" > /etc/hostname || true
    sed -i "/127.0.1.1/c\127.0.1.1 $SafeHostname" /etc/hosts || true
    if ! grep -q "$CurrentIP" /etc/hosts 2>/dev/null; then
        echo "$CurrentIP $SafeHostname" >> /etc/hosts || true
    fi

    # 3. Network Customization
    if [ -d "/etc/netplan" ] && command -v netplan >/dev/null 2>&1; then
        rm -f /etc/netplan/*.yaml || true
        echo "network:" > /etc/netplan/99-custom-static.yaml
        echo "  version: 2" >> /etc/netplan/99-custom-static.yaml
        echo "  renderer: networkd" >> /etc/netplan/99-custom-static.yaml
        echo "  ethernets:" >> /etc/netplan/99-custom-static.yaml
        echo "    `$IFACE:" >> /etc/netplan/99-custom-static.yaml
        echo "      dhcp4: no" >> /etc/netplan/99-custom-static.yaml
        echo "      addresses:" >> /etc/netplan/99-custom-static.yaml
        echo "        - $CurrentIP/24" >> /etc/netplan/99-custom-static.yaml
        echo "      gateway4: $CurrentGateway" >> /etc/netplan/99-custom-static.yaml
        echo "      nameservers:" >> /etc/netplan/99-custom-static.yaml
        echo "        addresses:" >> /etc/netplan/99-custom-static.yaml
        echo "          - $LoopDns1" >> /etc/netplan/99-custom-static.yaml
        echo "          - $LoopDns2" >> /etc/netplan/99-custom-static.yaml
        chmod 600 /etc/netplan/99-custom-static.yaml || true
        netplan apply || true
    elif grep -q 'VERSION_ID="7' /etc/os-release 2>/dev/null || [ -f "/etc/redhat-release" ] && grep -q 'release 7' /etc/redhat-release; then
        IFCFG="/etc/sysconfig/network-scripts/ifcfg-`$IFACE"
        printf "DEVICE=`$IFACE\nBOOTPROTO=none\nONBOOT=yes\nIPADDR=$CurrentIP\nPREFIX=24\nGATEWAY=$CurrentGateway\nDNS1=$LoopDns1\nDNS2=$LoopDns2\nPEERDNS=yes\n" > "`$IFCFG"
        chmod 644 "`$IFCFG" || true
        systemctl restart network || true
    elif command -v nmcli >/dev/null 2>&1; then
        # RHEL 8/9 / CentOS / Rocky / Alma (NetworkManager Native)
        CON_NAME=`$(nmcli -t -f NAME,DEVICE connection show | grep ":`$IFACE\$" | head -n 1 | cut -d: -f1)
        if [ -z "`$CON_NAME" ]; then
            CON_NAME=`$(nmcli -t -f NAME,TYPE connection show | grep "802-3-ethernet" | head -n 1 | cut -d: -f1)
        fi
        if [ -n "`$CON_NAME" ]; then
            nmcli connection modify "`$CON_NAME" ipv4.addresses "$CurrentIP/24" ipv4.gateway "$CurrentGateway" ipv4.dns "$LoopDns1,$LoopDns2" ipv4.method manual connection.autoconnect yes 802-3-ethernet.mac-address '' connection.interface-name "`$IFACE" || true
            nmcli connection up "`$CON_NAME" || true
        else
            nmcli connection add type ethernet con-name "`$IFACE-static" ifname "`$IFACE" ipv4.addresses "$CurrentIP/24" ipv4.gateway "$CurrentGateway" ipv4.dns "$LoopDns1,$LoopDns2" ipv4.method manual connection.autoconnect yes || true
            nmcli connection up "`$IFACE-static" || true
        fi
    fi

    # 4. Disable Firewalls
    if systemctl is-active --quiet firewalld || systemctl is-enabled --quiet firewalld 2>/dev/null; then
        systemctl stop firewalld || true
        systemctl disable firewalld || true
    fi
    if command -v ufw >/dev/null 2>&1; then
        ufw disable || true
    fi
"@
        $CloudContentUnix = $CloudContent -replace "`r`n", "`n"
    }

    # 1. Fetch template UUID from PE v2.0
    Write-Host "Locating template VM UUID..."
    $TemplateUuid = $null
    try {
        $allVms = Invoke-RestMethod -Uri "$TargetBaseUrl/vms" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
        $found = $allVms.entities | Where-Object { $_.name -eq $TargetTemplateName }
        if ($found) {
            $TemplateUuid = $found[0].uuid
        }
    } catch {
        Write-Host "Error querying templates from PE: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }

    if (-not $TemplateUuid) {
        Write-Host "Error: Cannot find template VM named [$TargetTemplateName] on Prism Element!" -ForegroundColor Red
        exit 1
    }

    Write-Host "Template UUID: [$TemplateUuid]"

    # 2. Trigger PE v2.0 Clone
    $CloneCustomConfig = $null
    if ($IsWinOS) {
        $XmlBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($XmlContent))
        $CloneCustomConfig = @{
            "sysprep" = @{
                "install_type" = "PREPARED"
                "unattend_xml" = $XmlBase64
            }
        }
    } else {
        $CloudBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CloudContentUnix))
        $CloneCustomConfig = @{
            "userdata" = $CloudBase64
        }
    }


    Write-Host "Triggering PE v2.0 VM Clone operation with embedded Guest Customization..."
    $CloneBody = @{
        "spec_list" = @(
            @{
                "name" = $CurrentName
                "num_vcpus" = [int]$NumCore
                "memory_mb" = [int]$MemoryMiB
                "vm_customization_config" = $CloneCustomConfig
            }
        )
    } | ConvertTo-Json -Depth 10

    $CloneTask = $null
    try {
        $CloneTask = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$TemplateUuid/clone" -Method Post -Headers $NutanixHeaders -Body $CloneBody -ErrorAction Stop
    } catch {
        Write-Host "Error triggering PE Clone: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            try {
                $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $ErrorBody = $Reader.ReadToEnd()
                Write-Host "API Response Detail: $ErrorBody" -ForegroundColor Yellow
            } catch {}
        }
        exit 1
    }

    $TaskUuid = $CloneTask.task_uuid
    if (-not $TaskUuid) {
        Write-Host "Error: No task UUID returned from PE clone API!" -ForegroundColor Red
        exit 1
    }

    Write-Host "PE Clone Task initiated. UUID: [$TaskUuid]"

    # 3. Poll PE Task until completion
    $TaskComplete = $false
    $TimeoutSec = 300
    $Elapsed = 0
    while (-not $TaskComplete -and $Elapsed -lt $TimeoutSec) {
        Start-Sleep -Seconds 5
        $Elapsed += 5
        try {
            $TaskStatus = Invoke-RestMethod -Uri "$TargetBaseUrl/tasks/$TaskUuid" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
            
            $StatusVal = $TaskStatus.status
            if ([string]::IsNullOrEmpty($StatusVal)) {
                $StatusVal = $TaskStatus.progress_status
            }
            
            Write-Host "   Polling task status: $($TaskStatus.percentage_complete)% ($StatusVal)"
            if ($StatusVal -eq "Succeeded" -or $StatusVal -eq "SUCCESS" -or $StatusVal -eq "succeeded") {
                $TaskComplete = $true
            } elseif ($StatusVal -eq "Failed" -or $StatusVal -eq "FAILED" -or $StatusVal -eq "failed") {
                Write-Host "Error: PE Clone task failed!" -ForegroundColor Red
                break
            }
        } catch {
            Write-Host "Warning: Failed to poll task status: $($_.Exception.Message)"
        }
    }

    if (-not $TaskComplete) {
        Write-Host "Error: VM Clone task timed out or failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "PE Clone task completed successfully!" -ForegroundColor Green

    # 4. Find the newly cloned VM UUID
    $NewVmUuid = $null
    try {
        $allVms = Invoke-RestMethod -Uri "$TargetBaseUrl/vms" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
        $newVm = $allVms.entities | Where-Object { $_.name -eq $CurrentName }
        if ($newVm) {
            $NewVmUuid = $newVm[0].uuid
        }
    } catch {
        Write-Host "Warning: Failed to find newly cloned VM UUID: $($_.Exception.Message)"
    }

    if (-not $NewVmUuid) {
        Write-Host "Error: Could not locate new VM UUID after clone!" -ForegroundColor Red
        exit 1
    }

    Write-Host "New VM UUID resolved: [$NewVmUuid]. Proceeding to customization Phase..." -ForegroundColor Green

    # 5. Fetch Cloned VM Complete Details for SCSI mapping and container resolution
    $VmDetail = $null
    try {
        $AllVmsList = Invoke-RestMethod -Uri "$TargetBaseUrl/vms?include_vm_nic_config=true&include_vm_disk_config=true" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
        if ($AllVmsList -and $AllVmsList.entities) {
            $MatchedEntities = $AllVmsList.entities | Where-Object { $_.uuid -eq $NewVmUuid }
            if ($MatchedEntities) {
                $VmDetail = $MatchedEntities[0]
            }
        }
        if (-not $VmDetail) {
            # Fallback if collection filter failed
            $VmDetail = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
        }
    } catch {
        Write-Host "Error: Failed to query VM details: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
    # DEBUG: Print all returned keys from Prism Element for VM details
    if ($VmDetail) {
        $Props = $VmDetail.PSObject.Properties.Name
        Write-Host "DEBUG: PE VM Detail returned keys: $($Props -join ', ')" -ForegroundColor Cyan
        $MatchNics = $Props | Where-Object { $_ -match "nic" -or $_ -match "network" -or $_ -match "interface" -or $_ -match "port" }
        Write-Host "DEBUG: Matching network/NIC keys: $($MatchNics -join ', ')" -ForegroundColor Cyan
        foreach ($Key in $MatchNics) {
            Write-Host "DEBUG: $Key = $($VmDetail.$Key | ConvertTo-Json -Compress)" -ForegroundColor Cyan
        }
    }

    # Ensure properties exist on VmDetail to avoid "The property cannot be found on this object" in PowerShell 5.1
    foreach ($Prop in @("network_interfaces", "virtual_network_interfaces", "nic_list", "vm_nics", "disk_list", "vm_disks", "customization_config", "vm_customization_config")) {
        if (-not (Get-Member -InputObject $VmDetail -Name $Prop)) {
            $VmDetail | Add-Member -MemberType NoteProperty -Name $Prop -Value $null -Force
        }
    }

    # Resolve target network VLAN UUID on target PE cluster
    Write-Host "Resolving Subnet VLAN Network UUID for [$LoopVlan]..."
    $NetworkUuid = $null
    try {
        $Networks = Invoke-RestMethod -Uri "$TargetBaseUrl/networks" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
        $MatchedNet = $Networks.entities | Where-Object { $_.name -eq $LoopVlan }
        if ($MatchedNet) {
            $NetworkUuid = $MatchedNet[0].uuid
            Write-Host "   Subnet VLAN UUID resolved: [$NetworkUuid]" -ForegroundColor Green
        } else {
            Write-Host "Warning: Could not find VLAN network named [$LoopVlan] on PE!" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Warning: Failed to query networks list from PE: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # Rescale CPU, memory
    $VmDetail.num_vcpus = [int]$NumCore
    $VmDetail.memory_mb = [int]$MemoryMiB

    # Network card VLAN connection (Updates existing interfaces via sub-resource endpoints for PE v2.0 API compatibility)
    if ($NetworkUuid) {
        $NicsList = @()
        if ($VmDetail.vm_nics) {
            $NicsList = $VmDetail.vm_nics
        } elseif ($VmDetail.network_interfaces) {
            $NicsList = $VmDetail.network_interfaces
        } elseif ($VmDetail.virtual_network_interfaces) {
            $NicsList = $VmDetail.virtual_network_interfaces
        } elseif ($VmDetail.nic_list) {
            $NicsList = $VmDetail.nic_list
        }

        if ($NicsList -and $NicsList.Count -gt 0) {
            # Update local representation to maintain consistency in the main PUT payload
            if ($VmDetail.vm_nics -and $VmDetail.vm_nics.Count -gt 0) {
                $VmDetail.vm_nics[0].network_uuid = $NetworkUuid
                $VmDetail.vm_nics[0].is_connected = $true
            }
            if ($VmDetail.network_interfaces -and $VmDetail.network_interfaces.Count -gt 0) {
                $VmDetail.network_interfaces[0].network_uuid = $NetworkUuid
                $VmDetail.network_interfaces[0].is_connected = $true
            }
            
            # Perform dedicated sub-resource PUT calls for each existing interface
            foreach ($Nic in $NicsList) {
                $Mac = $Nic.mac_address
                if ($Mac) {
                    Write-Host "   Updating network interface (MAC: $Mac) to VLAN UUID: [$NetworkUuid]..." -ForegroundColor Yellow
                    $NicBody = @{
                        "nic_spec" = @{
                            "network_uuid" = $NetworkUuid
                            "is_connected" = $true
                        }
                    } | ConvertTo-Json
                    try {
                        $null = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid/nics/$Mac" -Method Put -Headers $NutanixHeaders -Body $NicBody -ErrorAction Stop
                        Write-Host "   Network interface successfully updated to VLAN! [OK]" -ForegroundColor Green
                    } catch {
                        Write-Host "   Warning: Failed to update existing NIC (MAC: $Mac) via sub-endpoint: $($_.Exception.Message)" -ForegroundColor Yellow
                    }
                }
            }
        } else {
            Write-Host "   No existing network interface found. Creating new NIC for VLAN UUID: [$NetworkUuid]..." -ForegroundColor Yellow
            $NicBody = @{
                "network_uuid" = $NetworkUuid
                "is_connected" = $true
            } | ConvertTo-Json
            try {
                $null = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid/nics" -Method Post -Headers $NutanixHeaders -Body $NicBody -ErrorAction Stop
                Write-Host "   New network interface successfully created! [OK]" -ForegroundColor Green
            } catch {
                Write-Host "   Warning: Failed to create new NIC via sub-endpoint: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    # Disk Expansion & Storage Container resolution
    $StorageContainerUuid = $null
    $SourceDisks = if ($VmDetail.vm_disks) { $VmDetail.vm_disks } else { $VmDetail.disk_list }
    if ($SourceDisks) {
        foreach ($disk in $SourceDisks) {
            if ($disk.storage_container_uuid) {
                $StorageContainerUuid = $disk.storage_container_uuid
            } elseif ($disk.container_uuid) {
                $StorageContainerUuid = $disk.container_uuid
            } elseif ($disk.storage_config) {
                if ($disk.storage_config.storage_container_uuid) {
                    $StorageContainerUuid = $disk.storage_config.storage_container_uuid
                } elseif ($disk.storage_config.container_uuid) {
                    $StorageContainerUuid = $disk.storage_config.container_uuid
                } elseif ($disk.storage_config.storage_container -and $disk.storage_config.storage_container.uuid) {
                    $StorageContainerUuid = $disk.storage_config.storage_container.uuid
                }
            }
            if ($StorageContainerUuid) { break }
        }
    }

    # Fallback to query all storage containers on PE if none was resolved from existing disks
    if (-not $StorageContainerUuid) {
        Write-Host "   No storage container found in source disks. Querying storage containers from cluster..." -ForegroundColor Yellow
        try {
            $Containers = Invoke-RestMethod -Uri "$TargetBaseUrl/storage_containers" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
            if ($Containers -and $Containers.entities) {
                # Prefer containers that are not reserved/system, or just use the first available container
                $StorageContainerUuid = $Containers.entities[0].storage_container_uuid
                Write-Host "   Resolved fallback Storage Container UUID: [$StorageContainerUuid]" -ForegroundColor Green
            }
        } catch {
            Write-Host "   Warning: Failed to query storage containers fallback: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }


    # Resize or Add SCSI 0, 1, 2 (sda/C, sdb/L, sdc/X)
    $DiskList = @()
    $HasIndex1 = $false
    $HasIndex2 = $false
    if ($SourceDisks) {
        foreach ($disk in $SourceDisks) {
            $DevIndex = $null
            if ($disk.disk_address -and $disk.disk_address.adapter_type -eq "SCSI") {
                $DevIndex = $disk.disk_address.device_index
            } elseif ($disk.device_properties -and $disk.device_properties.disk_address -and $disk.device_properties.disk_address.adapter_type -eq "SCSI") {
                $DevIndex = $disk.device_properties.disk_address.device_index
            }
            
            if ($DevIndex -eq 0 -and $DiskPlan.C -gt 0) {
                $disk.disk_size_in_bytes = [double]$DiskPlan.C * 1024 * 1024 * 1024
                Write-Host "   Resizing SCSI 0 (C:/sda drive) to $($DiskPlan.C) GB" -ForegroundColor Yellow
            }
            if ($DevIndex -eq 1) {
                $HasIndex1 = $true
                if ($DiskPlan.L -gt 0) {
                    $disk.disk_size_in_bytes = [double]$DiskPlan.L * 1024 * 1024 * 1024
                    Write-Host "   Resizing SCSI 1 (L:/sdb drive) to $($DiskPlan.L) GB" -ForegroundColor Yellow
                }
            }
            if ($DevIndex -eq 2) {
                $HasIndex2 = $true
                if ($DiskPlan.X -gt 0) {
                    $disk.disk_size_in_bytes = [double]$DiskPlan.X * 1024 * 1024 * 1024
                    Write-Host "   Resizing SCSI 2 (X:/sdc drive) to $($DiskPlan.X) GB" -ForegroundColor Yellow
                }
            }
            $DiskList += $disk
        }
    }

    # If SCSI index 1 is not present in template but specified, append new disk
    if (-not $HasIndex1 -and $DiskPlan.L -gt 0) {
        Write-Host "   Adding new SCSI 1 (L:/sdb drive) disk with $($DiskPlan.L) GB..." -ForegroundColor Yellow
        $NewDisk1 = @{
            "device_properties" = @{
                "device_type" = "DISK"
                "disk_address" = @{
                    "adapter_type" = "SCSI"
                    "device_index" = 1
                }
            }
            "disk_size_in_bytes" = [double]$DiskPlan.L * 1024 * 1024 * 1024
        }
        if ($StorageContainerUuid) {
            $NewDisk1.Add("storage_container_uuid", $StorageContainerUuid)
        }
        $DiskList += $NewDisk1
    }

    # If SCSI index 2 is not present in template but specified, append new disk
    if (-not $HasIndex2 -and $DiskPlan.X -gt 0) {
        Write-Host "   Adding new SCSI 2 (X:/sdc drive) disk with $($DiskPlan.X) GB..." -ForegroundColor Yellow
        $NewDisk2 = @{
            "device_properties" = @{
                "device_type" = "DISK"
                "disk_address" = @{
                    "adapter_type" = "SCSI"
                    "device_index" = 2
                }
            }
            "disk_size_in_bytes" = [double]$DiskPlan.X * 1024 * 1024 * 1024
        }
        if ($StorageContainerUuid) {
            $NewDisk2.Add("storage_container_uuid", $StorageContainerUuid)
        }
        $DiskList += $NewDisk2
    }

    $VmDetail.disk_list = $DiskList
    $VmDetail.vm_disks = $DiskList



    # Inject Unattend.xml (Windows) or userdata (Linux Cloud-Init)
    if ($IsWinOS) {
        Write-Host "   Injecting Sysprep base64 unattended XML configuration..." -ForegroundColor Yellow
        $XmlBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($XmlContent))
        $CustomConfig = @{
            "sysprep" = @{
                "install_type" = "PREPARED"
                "unattend_xml" = $XmlBase64
            }
        }
        $VmDetail.vm_customization_config = $CustomConfig
        $VmDetail.customization_config = @{
            "install_type" = "PREPARED"
            "unattend_xml" = $XmlBase64
        }
    } else {
        Write-Host "   Injecting Cloud-init base64 userdata configuration..." -ForegroundColor Yellow
        $CloudBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CloudContentUnix))
        $CustomConfig = @{
            "userdata" = $CloudBase64
        }
        $VmDetail.vm_customization_config = $CustomConfig
        $VmDetail.customization_config = @{
            "userdata" = $CloudBase64
        }
    }


    # Send PUT update back to Prism Element v2.0
    Write-Host "Sending VM updates (customization config, networking, disk scaling) to Prism Element..." -ForegroundColor Cyan
    $PutBody = $VmDetail | ConvertTo-Json -Depth 10

    try {
        $null = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid" -Method Put -Headers $NutanixHeaders -Body $PutBody -ErrorAction Stop
        Write-Host "   VM properties updated and customized successfully! [OK]" -ForegroundColor Green

        # Attach secondary disks (SCSI 1 / L: drive, SCSI 2 / X: drive) using PE-native sub-resource API
        if ($DiskPlan.L -gt 0) {
            Write-Host "   Attaching SCSI 1 (L: drive) with $($DiskPlan.L) GB..." -ForegroundColor Yellow
            $NewDisk1Spec = @{
                "is_cdrom" = $false
                "is_empty" = $false
                "disk_address" = @{
                    "adapter_type" = "SCSI"
                    "device_bus" = "SCSI"
                    "device_index" = 1
                }
                "vm_disk_create" = @{
                    "size" = [double]$DiskPlan.L * 1024 * 1024 * 1024
                }
            }
            if ($StorageContainerUuid) {
                $NewDisk1Spec.vm_disk_create.Add("storage_container_uuid", $StorageContainerUuid)
            }
            $AttachBody1 = @{
                "vm_disks" = @($NewDisk1Spec)
            } | ConvertTo-Json -Depth 10

            try {
                $null = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid/disks/attach" -Method Post -Headers $NutanixHeaders -Body $AttachBody1 -ErrorAction Stop
                Write-Host "   Successfully attached SCSI 1 (L: drive)! [OK]" -ForegroundColor Green
            } catch {
                Write-Host "   Warning: Failed to attach SCSI 1 (L: drive): $($_.Exception.Message)" -ForegroundColor Yellow
                if ($_.Exception.Response) {
                    try {
                        $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                        $ErrorBody = $Reader.ReadToEnd()
                        Write-Host "API Response Detail: $ErrorBody" -ForegroundColor Yellow
                    } catch {}
                }
            }
        }

        if ($DiskPlan.X -gt 0) {
            Write-Host "   Attaching SCSI 2 (X: drive) with $($DiskPlan.X) GB..." -ForegroundColor Yellow
            $NewDisk2Spec = @{
                "is_cdrom" = $false
                "is_empty" = $false
                "disk_address" = @{
                    "adapter_type" = "SCSI"
                    "device_bus" = "SCSI"
                    "device_index" = 2
                }
                "vm_disk_create" = @{
                    "size" = [double]$DiskPlan.X * 1024 * 1024 * 1024
                }
            }
            if ($StorageContainerUuid) {
                $NewDisk2Spec.vm_disk_create.Add("storage_container_uuid", $StorageContainerUuid)
            }
            $AttachBody2 = @{
                "vm_disks" = @($NewDisk2Spec)
            } | ConvertTo-Json -Depth 10

            try {
                $null = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid/disks/attach" -Method Post -Headers $NutanixHeaders -Body $AttachBody2 -ErrorAction Stop
                Write-Host "   Successfully attached SCSI 2 (X: drive)! [OK]" -ForegroundColor Green
            } catch {
                Write-Host "   Warning: Failed to attach SCSI 2 (X: drive): $($_.Exception.Message)" -ForegroundColor Yellow
                if ($_.Exception.Response) {
                    try {
                        $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                        $ErrorBody = $Reader.ReadToEnd()
                        Write-Host "API Response Detail: $ErrorBody" -ForegroundColor Yellow
                    } catch {}
                }
            }
        }
    } catch {
        Write-Host "Error: Failed to update VM customization properties: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            try {
                $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $ErrorBody = $Reader.ReadToEnd()
                Write-Host "API Response Detail: $ErrorBody" -ForegroundColor Yellow
            } catch {}
        }
        exit 1
    }

    # 6. Power ON the newly cloned and customized VM in PE v2.0
    Write-Host "Powering on new VM [$CurrentName]..."
    try {
        $PowerBody = @{
            "transition" = "ON"
        } | ConvertTo-Json
        $null = Invoke-RestMethod -Uri "$TargetBaseUrl/vms/$NewVmUuid/set_power_state" -Method Post -Headers $NutanixHeaders -Body $PowerBody -ErrorAction Stop
        Write-Host "Successfully powered ON new VM!" -ForegroundColor Green
    } catch {
        Write-Host "Warning: Failed to power ON new VM: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host "=============================================" -ForegroundColor Green
Write-Host "   PE VM Provisioning Complete!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
