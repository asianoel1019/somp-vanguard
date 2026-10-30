# =======================================================
# Headless Nutanix VM Auto Provisioning Script (API version)
# Compatible with PowerShell 5.1 (Windows Server 2016)
# =======================================================
[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$ParamFile
)

# 0. PowerShell 5.1 SSL/TLS compatibility setup
# -SkipCertificateCheck is PS7-only. We use .NET callback instead.
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
    # Type may already be loaded if script runs multiple times in same session
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. Read and parse parameter file
if ($ParamFile) {
    $ParamFile = $ParamFile.Trim().Trim('"').Trim("'")
}

if (-not (Test-Path $ParamFile)) {
    Write-Error "Error: Cannot find parameter file: $ParamFile"
    exit 1
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   VM Headless Auto Provisioning Tool (API version)" -ForegroundColor Cyan
Write-Host "   PowerShell 5.1 Compatible Edition" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "Loading parameters from: $ParamFile"

$Params = Get-Content -Raw $ParamFile | ConvertFrom-Json

$PrismCentralIP  = $Params.PrismCentralIP
$BaseUrl         = "https://${PrismCentralIP}:9440/api/nutanix/v3"
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

$HasWindowsVM = $false
foreach ($VMItem in $BatchList) {
    $VMOS = $VMItem.OS
    $IsWin = $true
    if ($VMOS -match "Linux" -or $VMOS -match "Ubuntu" -or $VMOS -match "CentOS" -or $VMOS -match "RHEL" -or $VMOS -match "RedHat" -or $VMOS -match "Debian" -or $VMOS -match "Rocky" -or $VMOS -match "Alma" -or $VMOS -match "SUSE" -or $VMOS -match "SLES" -or $VMOS -match "OEL" -or $VMOS -match "Oracle") {
        $IsWin = $false
    }
    if ($IsWin) {
        $HasWindowsVM = $true
    }
}

# Build qualified AD username for cross-domain trust LDAP auth
if ($HasWindowsVM) {
    if ($AllowedADDomain) {
        $QualifiedJoinUser = "$AllowedADDomain\$JoinUser"
        Write-Host "   AD Domain Trust Mode: LDAP bind will use [$QualifiedJoinUser]" -ForegroundColor Cyan
    } else {
        $QualifiedJoinUser = $JoinUser
        Write-Host "   AD Domain: Using default credentials [$JoinUser]" -ForegroundColor Cyan
    }
} else {
    Write-Host "   Linux-only batch detected. Skipping Active Directory credential binding." -ForegroundColor Cyan
}

# 2. Build Nutanix API Headers
$pair = "${NUser}:${NPass}"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pair)
$base64 = [System.Convert]::ToBase64String($bytes)
$NutanixHeaders = @{
    'Accept'        = 'application/json'
    'Authorization' = "Basic $base64"
    'Content-Type'  = 'application/json'
}

Write-Host "   Testing Nutanix API connection..." -NoNewline
try {
    $null = Invoke-RestMethod -Uri "$BaseUrl/users/me" -Method Get -Headers $NutanixHeaders -ErrorAction Stop
    Write-Host " Connected successfully! [OK]" -ForegroundColor Green
}
catch {
    Write-Host " Failed! [ERROR]" -ForegroundColor Red
    Write-Host "   Detail: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   Please verify Prism Central IP ($PrismCentralIP), credentials, or network connectivity." -ForegroundColor Red
    exit 1
}

Write-Host "Starting VM provisioning for $($BatchList.Count) targets (using background jobs, throttle=5)..." -ForegroundColor Yellow

# 3. VM Provisioning execution using Start-Job (PS5.1 compatible parallel approach)
# Define the worker script block that each job will execute
$WorkerScriptBlock = {
    param(
        [string]$VMJson,
        [string]$HeadersJson,
        [string]$BaseUrl,
        [string]$JoinUser,
        [string]$JoinPass,
        [string]$AllowedADDomain,
        [string]$LocalAdmin,
        [string]$LinuxAdmin,
        [string]$IPSwitchMapJson,
        [string]$RemoteInstallConfigJson,
        [string]$TemplateBUMapJson
    )

    # Override Write-Host to write to Success Stream so Start-Job / Receive-Job captures it
    function Write-Host {
        param(
            [Parameter(ValueFromPipeline=$true, Position=0)]
            [string]$Object,
            [string]$ForegroundColor,
            [string]$BackgroundColor,
            [switch]$NoNewline
        )
        Write-Output $Object
    }

    # PS5.1 SSL setup inside job (each job has its own runspace)
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
    } catch {}
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $VM = $VMJson | ConvertFrom-Json
    $CurrentName = $VM.Name
    $CurrentIP   = $VM.IP
    $NumCore     = $VM.NumCore
    $MemoryMiB   = $VM.MemoryMiB
    $OS          = $VM.OS
    $RawBU       = $VM.BU
    $DiskPlan    = $VM.DiskInfo

    # Determine if target OS is Windows or Linux
    $IsWinOS = $true
    if ($OS -match "Linux" -or $OS -match "Ubuntu" -or $OS -match "CentOS" -or $OS -match "RHEL" -or $OS -match "RedHat" -or $OS -match "Debian" -or $OS -match "Rocky" -or $OS -match "Alma" -or $OS -match "SUSE" -or $OS -match "SLES" -or $OS -match "OEL" -or $OS -match "Oracle") {
        $IsWinOS = $false
    }

    $Headers = $HeadersJson | ConvertFrom-Json
    # ConvertFrom-Json returns PSCustomObject, need to convert to hashtable for Invoke-RestMethod
    $HeadersHT = @{}
    $Headers.PSObject.Properties | ForEach-Object { $HeadersHT[$_.Name] = $_.Value }
    $Headers = $HeadersHT

    $IPSwitchMap = $IPSwitchMapJson | ConvertFrom-Json
    $RemoteInstall = $RemoteInstallConfigJson | ConvertFrom-Json
    $TemplateBUMap = if ($TemplateBUMapJson) { $TemplateBUMapJson | ConvertFrom-Json } else { @() }

    # Establish dynamic SMB connection/authentication to NAS share on the dispatcher host (Windows-only)
    if ($IsWinOS -and $RemoteInstall.nasPath -and $RemoteInstall.nasPath.StartsWith('\\')) {
        $QualifiedJoinUser = if ($AllowedADDomain) { "$AllowedADDomain\$JoinUser" } else { $JoinUser }
        Write-Host "   [$CurrentName] Establishing host session authentication to NAS share $($RemoteInstall.nasPath)..." -ForegroundColor Cyan
        try {
            # 1. Map temporary PSDrive
            $DriveName = "NASDrive"
            if (Get-PSDrive -Name $DriveName -ErrorAction SilentlyContinue) {
                Remove-PSDrive -Name $DriveName -Force -ErrorAction SilentlyContinue
            }
            $SafePass = if ($JoinPass) { $JoinPass } else { "" }
            $SecPass = ConvertTo-SecureString $SafePass -AsPlainText -Force
            $NasCred = New-Object System.Management.Automation.PSCredential ($QualifiedJoinUser, $SecPass)
            $null = New-PSDrive -Name $DriveName -PSProvider FileSystem -Root $RemoteInstall.nasPath -Credential $NasCred -ErrorAction Stop
            
            # 2. Also map via net use for absolute global redirector authentication compatibility in older PS engines
            $NasUnc = $RemoteInstall.nasPath
            $JoinUserEscaped = $QualifiedJoinUser -replace '"', '\"'
            $JoinPassEscaped = $JoinPass -replace '"', '\"'
            net use $NasUnc $JoinPassEscaped /user:$JoinUserEscaped /persistent:no *>$null
            
            Write-Host "     > NAS share successfully authenticated and mapped to PSDrive [$DriveName`:]! [OK]" -ForegroundColor Green
        } catch {
            Write-Host "     > Warning: Host SMB redirector authentication failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # BU Mapping logic
    $BUMap = @{
        "188Asia"="188"; "B2B"="B2B"; "BI"="BI"; "CSP-TA"="CSP-TA";
        "INFRA-APP"="APP"; "INFRA-CEM"="CEM"; "INFRA-DBA"="DBA"; "INFRA-NET"="NET";
        "INFRA-OPS"="OPS"; "INFRA-CWD"="CWD"; "INFRA-SYS"="SYS"; "INFRA-TS"="SEC";
        "NBG"="NBG"; "OFC"="OFC"; "SBK"="SBK"; "TRS"="TRS"; "TRS-TW"="TRS-TW"
    }
    $FinalBU = if ($BUMap.ContainsKey($RawBU)) { $BUMap[$RawBU] } else { $RawBU }

    # Parse IP
    $IPParts = $CurrentIP -split '\.'
    if ($IPParts.Count -ne 4) {
        Write-Host "Error: [$CurrentName] Invalid IP address format: $CurrentIP" -ForegroundColor Red
        return
    }
    $cprIPPre = "$($IPParts[0]).$($IPParts[1]).$($IPParts[2])"
    $CurrentGateway = "$cprIPPre.254"
    $SafeHostname = if ($IsWinOS -and $CurrentName.Length -gt 15) { $CurrentName.Substring(0, 15) } else { $CurrentName }

    # Search for subnet in IP Switch Map
    $Matched = $IPSwitchMap | Where-Object { $_.subnetPrefix -eq $cprIPPre }
    if ($null -eq $Matched) {
        Write-Host "Error: [$CurrentName] Cannot resolve subnet prefix ($cprIPPre) in IP Switch Map database! Skipping..." -ForegroundColor Red
        return
    }

    $LoopOULayer = $Matched.ouLayer
    $LoopCluster = $Matched.cluster
    $LoopZone    = $Matched.zone
    $LoopDns1    = $Matched.dns1
    $LoopDns2    = $Matched.dns2
    $LoopVlan    = $Matched.vlan

    # ouLayer now contains the base OU distinguished name path from IP Switch Mapping
    # Prepend the BU to the OU path as requested (e.g. OU=Marketing,OU=Trust,...)
    $TargetDN = "OU=$FinalBU,$LoopOULayer"

    # Dynamic Template selection logic from TemplateBUMap configuration
    $TargetTemplateName = ""
    $MatchedMapping = $null

    if ($TemplateBUMap) {
        # 1. Search for an exact match (OS, BU, and Cluster all match)
        $MatchedMapping = $TemplateBUMap | Where-Object { 
            ($OS -match $_.os) -and ($FinalBU -eq $_.bu) -and ($_.cluster -eq $LoopCluster) 
        }
        
        # 2. Search for fallback BU match within the same Cluster
        if (-not $MatchedMapping) {
            $MatchedMapping = $TemplateBUMap | Where-Object { 
                ($OS -match $_.os) -and ($_.bu -eq "Default" -or $_.bu -eq "All" -or [string]::IsNullOrEmpty($_.bu)) -and ($_.cluster -eq $LoopCluster) 
            }
        }

        # 3. Search for exact BU match on "All" clusters / Global
        if (-not $MatchedMapping) {
            $MatchedMapping = $TemplateBUMap | Where-Object { 
                ($OS -match $_.os) -and ($FinalBU -eq $_.bu) -and ($_.cluster -eq "All" -or [string]::IsNullOrEmpty($_.cluster)) 
            }
        }

        # 4. Search for fallback BU match on "All" clusters / Global
        if (-not $MatchedMapping) {
            $MatchedMapping = $TemplateBUMap | Where-Object { 
                ($OS -match $_.os) -and ($_.bu -eq "Default" -or $_.bu -eq "All" -or [string]::IsNullOrEmpty($_.bu)) -and ($_.cluster -eq "All" -or [string]::IsNullOrEmpty($_.cluster)) 
            }
        }
    }

    if ($MatchedMapping) {
        # If multiple matches returned, pick the first one
        if ($MatchedMapping -is [array]) {
            $MatchedMapping = $MatchedMapping[0]
        }
        $TargetTemplateName = $MatchedMapping.template
        Write-Host "   [$CurrentName] Resolved template: [$TargetTemplateName] from dynamic mapping (OS: $($MatchedMapping.os), BU: $($MatchedMapping.bu), Cluster: $($MatchedMapping.cluster))" -ForegroundColor Green
    } else {
        # Fallback to the original hardcoded rules in case mapping is completely empty or missing
        Write-Host "   [$CurrentName] Warning: No dynamic Template-BU mapping found. Falling back to default rules..." -ForegroundColor Yellow
        if ($OS -match "W2K16") {
            $TargetTemplateName = "Template_2016_20240717"
        }
        elseif ($OS -match "W2K19") {
            if ($FinalBU -eq "188") { $TargetTemplateName = "Template_2019_20240717_188" }
            elseif ($FinalBU -eq "DBA") { $TargetTemplateName = "Template_2019_20240717_DBA" }
            else { $TargetTemplateName = "Template_2019_20240717" }
        }
        else {
            # Linux fallback template target
            $TargetTemplateName = "Template_Linux_Default"
        }
    }

    if ([string]::IsNullOrEmpty($TargetTemplateName)) {
        Write-Host "Error: [$CurrentName] Unknown or unsupported Operating System target: $OS (No dynamic or fallback template found)" -ForegroundColor Red
        return
    }

    Write-Host "   [$CurrentName] Querying Cluster ($LoopCluster) for Template ($TargetTemplateName) and Subnet VLAN ($LoopVlan)..." -ForegroundColor Cyan

    # Search Template UUID & Subnet UUID
    try {
        $VmFilter = "vm_name==$TargetTemplateName;cluster_name==$LoopCluster"
        $ListPayload = @{ "kind"="vm"; "filter"=$VmFilter } | ConvertTo-Json
        $ListRes = Invoke-RestMethod -Uri "$BaseUrl/vms/list" -Method Post -Headers $Headers -Body $ListPayload -TimeoutSec 30
        if ($ListRes.metadata.total_matches -eq 0) {
            Write-Host "Error: [$CurrentName] Template target VM not found on PC: [$TargetTemplateName] (Cluster: $LoopCluster). Please check Template-BU Mapping or VM name in Prism Central." -ForegroundColor Red
            return
        }
        $LoopTemplateUUID = $ListRes.entities[0].metadata.uuid
        
        $SubFilter = "name==$LoopVlan;cluster_name==$LoopCluster"
        $SubnetPayload = @{ "kind"="subnet"; "filter"=$SubFilter } | ConvertTo-Json
        $SubnetRes = Invoke-RestMethod -Uri "$BaseUrl/subnets/list" -Method Post -Headers $Headers -Body $SubnetPayload -TimeoutSec 30
        if ($SubnetRes.metadata.total_matches -eq 0) {
            Write-Host "Error: [$CurrentName] Target Subnet VLAN not found on PC: [$LoopVlan] (Cluster: $LoopCluster). Please check IP Switch Map settings." -ForegroundColor Red
            return
        }
        $LoopSubnetUUID = $SubnetRes.entities[0].metadata.uuid
    } catch {
        Write-Host "Error: [$CurrentName] Failed query against Nutanix API resources: $($_.Exception.Message)" -ForegroundColor Red
        return
    }

    # Clone & Sysprep / Cloud-Init unattended Setup
    try {
        $GuestCustomization = @{
            "is_overridable" = $true
        }

        $EscapedLocalAdmin = if ($LocalAdmin) { [System.Security.SecurityElement]::Escape($LocalAdmin) } else { "" }

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
      <!-- UnattendedJoin removed. AD Join shifted to WinRM script block to prevent DJOIN.EXE Sysprep hang -->
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
            <Password><Value>$EscapedLocalAdmin</Value><PlainText>true</PlainText></Password>
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
            $XmlBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($XmlContent))
            $GuestCustomization.Add("sysprep", @{ "install_type" = "PREPARED"; "unattend_xml" = $XmlBase64 })
        } else {
            Write-Host "   [$CurrentName] Linux VM detected. Configuring Cloud-Init setup (bypassing Active Directory domain registration and OU relocation)." -ForegroundColor Cyan
            $EscapedLinuxAdmin = if ($LinuxAdmin) { $LinuxAdmin.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$') } else { "" }
            $CloudContent = @"
#cloud-config
disable_root: false
ssh_pwauth: true
ssh_deletekeys: false
hostname: $SafeHostname
runcmd:
  - |
    set +e

    # 1. SSH Host Keys & SSHD Service Initialization (Auto-generate host keys for RHEL 9)
    ssh-keygen -A || true
    systemctl restart sshd || true

    # 2. Configure Root Password & Unlock Root Account if password provided
    if [ -n "$EscapedLinuxAdmin" ]; then
        usermod -U root || true
        echo "root:$EscapedLinuxAdmin" | chpasswd || true
    fi

    # 3. Detect first ethernet interface
    IFACE=`$(ls /sys/class/net | grep -v lo | head -n 1)
    if [ -z "`$IFACE" ]; then
        IFACE="eth0"
    fi

    # 4. Hostname Setup
    hostnamectl set-hostname "$SafeHostname" || true
    echo "$SafeHostname" > /etc/hostname || true
    sed -i "/127.0.1.1/c\127.0.1.1 $SafeHostname" /etc/hosts || true
    if ! grep -q "$CurrentIP" /etc/hosts 2>/dev/null; then
        echo "$CurrentIP $SafeHostname" >> /etc/hosts || true
    fi

    # 5. Network Customization
    if [ -d "/etc/netplan" ] && command -v netplan >/dev/null 2>&1; then
        # Ubuntu/Debian Netplan
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
        # CentOS/RHEL 7 legacy network scripts
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

    # 6. Disable Firewalls
    if systemctl is-active --quiet firewalld || systemctl is-enabled --quiet firewalld 2>/dev/null; then
        systemctl stop firewalld || true
        systemctl disable firewalld || true
    fi
    if command -v ufw >/dev/null 2>&1; then
        ufw disable || true
    fi

    # 7. Clean up initialization script
    rm -f /home/xyuser/initialization.sh || true

    # 8. Final SSHD restart to ensure service readiness
    systemctl restart sshd || true
"@
            # Normalize CRLF to LF to prevent Windows carriage returns from breaking Linux shell scripts inside cloud-init
            $CloudContentUnix = $CloudContent -replace "`r`n", "`n"
            $CloudBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CloudContentUnix))
            $GuestCustomization.Add("cloud_init", @{ "user_data" = $CloudBase64 })
        }

        $ClonePayload = @{
            "override_spec" = @{
                "name" = $CurrentName
                "num_sockets" = 1
                "num_vcpus_per_socket" = $NumCore
                "memory_size_mib" = $MemoryMiB
                "nic_list" = @( @{
                    "subnet_reference" = @{ "kind"="subnet"; "uuid"=$LoopSubnetUUID }
                    "is_connected" = $true
                })
                "guest_customization" = $GuestCustomization
            }
        } | ConvertTo-Json -Depth 10

        Write-Host "   [$CurrentName] Sending VM Clone request to Nutanix Prism Central..." -ForegroundColor Cyan
        $CloneRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$LoopTemplateUUID/clone" -Method Post -Headers $Headers -Body $ClonePayload
        $TaskUUID = $CloneRes.task_uuid

        do {
            Start-Sleep -Seconds 5
            $TaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$TaskUUID" -Method Get -Headers $Headers
        } while ($TaskInfo.status -eq "RUNNING" -or $TaskInfo.status -eq "QUEUED")

        if ($TaskInfo.status -eq "SUCCEEDED") {
            $NewVMUUID = $TaskInfo.entity_reference_list[0].uuid
            Write-Host "   [$CurrentName] Clone succeeded. Launching update phase 1 (disk expansion and power on)..." -ForegroundColor Green

            # Phase 1 Update: Expand Disks & Power ON VM
            try {
                $VmDetail = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
            } catch {
                Write-Host "Error: [$CurrentName] Failed to query new VM details" -ForegroundColor Red
                return
            }

            $VmSpec = $VmDetail.spec
            $Metadata = $VmDetail.metadata
            $ActionLog = @()

            # Set power ON
            $VmSpec.resources.power_state = "ON"
            $ActionLog += "PowerON"

            # Extract storage container reference of SCSI index 0 to use for additional disks
            $StorageContainerRef = $null
            foreach ($disk in $VmSpec.resources.disk_list) {
                if ($disk.device_properties.disk_address.adapter_type -eq "SCSI" -and $disk.device_properties.disk_address.device_index -eq 0) {
                    if ($disk.storage_config -and $disk.storage_config.storage_container_reference) {
                        $StorageContainerRef = $disk.storage_config.storage_container_reference
                    }
                }
            }
            if ($null -eq $StorageContainerRef) {
                foreach ($disk in $VmSpec.resources.disk_list) {
                    if ($disk.storage_config -and $disk.storage_config.storage_container_reference) {
                        $StorageContainerRef = $disk.storage_config.storage_container_reference
                        break
                    }
                }
            }


            # Check existing SCSI disk indices
            $HasIndex1 = $false
            $HasIndex2 = $false
            foreach ($disk in $VmSpec.resources.disk_list) {
                if ($disk.device_properties.disk_address.adapter_type -eq "SCSI") {
                    $Index = $disk.device_properties.disk_address.device_index
                    if ($Index -eq 1) { $HasIndex1 = $true }
                    if ($Index -eq 2) { $HasIndex2 = $true }
                }
            }

            # Disk Expansion (SCSI Adapter target index)
            foreach ($disk in $VmSpec.resources.disk_list) {
                if ($disk.device_properties.disk_address.adapter_type -eq "SCSI") {
                    $Index = $disk.device_properties.disk_address.device_index
                    if ($Index -eq 0 -and $DiskPlan.C -gt 0) {
                        $TargetMiB = $DiskPlan.C * 1024
                        if ($TargetMiB -gt $disk.disk_size_mib) { $disk.disk_size_mib = $TargetMiB; $ActionLog += "C/sda: $($DiskPlan.C)G" }
                    }
                    if ($Index -eq 1 -and $DiskPlan.L -gt 0) {
                        $TargetMiB = $DiskPlan.L * 1024
                        if ($TargetMiB -gt $disk.disk_size_mib) { $disk.disk_size_mib = $TargetMiB; $ActionLog += "L/sdb: $($DiskPlan.L)G" }
                    }
                    if ($Index -eq 2 -and $DiskPlan.X -gt 0) {
                        $TargetMiB = $DiskPlan.X * 1024
                        if ($TargetMiB -gt $disk.disk_size_mib) { $disk.disk_size_mib = $TargetMiB; $ActionLog += "X/sdc: $($DiskPlan.X)G" }
                    }
                }
            }

            # Build a list of disks (ensuring it's an array we can append to)
            $DiskList = @()
            if ($VmSpec.resources.disk_list -is [array]) {
                $DiskList = $VmSpec.resources.disk_list
            } elseif ($null -ne $VmSpec.resources.disk_list) {
                $DiskList = @($VmSpec.resources.disk_list)
            }

            # Dynamically append SCSI index 1 if it is missing but specified
            if (-not $HasIndex1 -and $DiskPlan.L -gt 0) {
                $NewDisk1 = @{
                    "device_properties" = @{
                        "device_type" = "DISK"
                        "disk_address" = @{
                            "adapter_type" = "SCSI"
                            "device_index" = 1
                        }
                    }
                    "disk_size_mib" = $DiskPlan.L * 1024
                }
                if ($null -ne $StorageContainerRef) {
                    $NewDisk1.Add("storage_config", @{
                        "storage_container_reference" = $StorageContainerRef
                    })
                }
                $DiskList += [PSCustomObject]$NewDisk1
                $ActionLog += "Added L/sdb: $($DiskPlan.L)G"
            }

            # Dynamically append SCSI index 2 if it is missing but specified
            if (-not $HasIndex2 -and $DiskPlan.X -gt 0) {
                $NewDisk2 = @{
                    "device_properties" = @{
                        "device_type" = "DISK"
                        "disk_address" = @{
                            "adapter_type" = "SCSI"
                            "device_index" = 2
                        }
                    }
                    "disk_size_mib" = $DiskPlan.X * 1024
                }
                if ($null -ne $StorageContainerRef) {
                    $NewDisk2.Add("storage_config", @{
                        "storage_container_reference" = $StorageContainerRef
                    })
                }
                $DiskList += [PSCustomObject]$NewDisk2
                $ActionLog += "Added X/sdc: $($DiskPlan.X)G"
            }

            $VmSpec.resources.disk_list = $DiskList

            Write-Host "     > Phase 1 Action checklist: $($ActionLog -join ', ')" -ForegroundColor DarkGray
            $UpdateBody = @{ "spec" = $VmSpec; "metadata" = $Metadata } | ConvertTo-Json -Depth 10

            $SetupName = if ($IsWinOS) { "Sysprep" } else { "Cloud-Init" }
            $ProbePort = if ($IsWinOS) { 3389 } else { 22 }
            $ProbeName = if ($IsWinOS) { "RDP" } else { "SSH" }

            try {
                $null = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $UpdateBody
                Write-Host "   [$CurrentName] Power command dispatched! Waiting for $SetupName setup (30 seconds static sleep)..." -ForegroundColor Green
            } catch {
                Write-Host "Error: [$CurrentName] Phase 1 update and power dispatch failed: $_" -ForegroundColor Red
                return
            }

            # Probe port tcping loop
            Start-Sleep -Seconds 30
            Write-Host "   [$CurrentName] Probing network interface and $ProbeName (Port $ProbePort) service..." -ForegroundColor Cyan
            
            $PortReady = $false
            $PortRetry = 0
            $MaxPortRetry = 40 # Max attempts 40 times (5 seconds sleep, total ~3.5 minutes)

            do {
                $PortRetry++
                try {
                    $TcpClient = New-Object System.Net.Sockets.TcpClient
                    $AsyncResult = $TcpClient.BeginConnect($CurrentIP, $ProbePort, $null, $null)
                    $WaitHandle = $AsyncResult.AsyncWaitHandle.WaitOne([timespan]::FromSeconds(2), $false)
                    
                    if ($WaitHandle -and $TcpClient.Connected) {
                        $PortReady = $true
                        Write-Host "     > Port $ProbePort $ProbeName is open! System network interface is ready." -ForegroundColor Green
                    }
                    $TcpClient.Close()
                } catch {}

                if (-not $PortReady -and $PortRetry -lt $MaxPortRetry) {
                    Start-Sleep -Seconds 5
                }
            } until ($PortReady -or $PortRetry -ge $MaxPortRetry)

            if (-not $PortReady) {
                Write-Host "     > Warning: $ProbeName probe timeout! Continuing..." -ForegroundColor Yellow
            }

            if ($IsWinOS) {
                # ---------------- SERVER PROVISIONING INTEGRATION (WinRM & AD Join) ----------------
                Write-Host "     > [Server Provision] Connecting to VM guest OS at $CurrentIP using Local Admin credentials..." -ForegroundColor Yellow
                        
                        $SecPass = ConvertTo-SecureString $LocalAdmin -AsPlainText -Force
                        $Cred = New-Object System.Management.Automation.PSCredential ("Administrator", $SecPass)
                        
                        $Session = $null
                        $SessionRetries = 0
                        $MaxSessionRetries = 30 # Increased to wait up to 5 minutes for Sysprep to complete
                        
                        do {
                            $SessionRetries++
                            try {
                                Write-Host "     > [Server Provision] Establishing WinRM session (attempt $SessionRetries/$MaxSessionRetries)..." -ForegroundColor DarkGray
                                $Session = New-PSSession -ComputerName $CurrentIP -Credential $Cred -ErrorAction Stop
                                Write-Host "     > [Server Provision] WinRM session established successfully!" -ForegroundColor Green
                            } catch {
                                Write-Host "     > [Server Provision] Connection failed: $($_.Exception.Message)" -ForegroundColor Yellow
                                if ($SessionRetries -lt $MaxSessionRetries) {
                                    Start-Sleep -Seconds 10
                                }
                            }
                        } until ($Session -ne $null -or $SessionRetries -ge $MaxSessionRetries)

                        if ($null -ne $Session) {
                            # 1. Run Disk Setup & NIC Rename on guest first to prepare target X:\ drive
                            $PrepScript = @"
function Write-Host {
    param(
        [Parameter(ValueFromPipeline=`$true, Position=0)]
        [string]`$Object,
        [string]`$ForegroundColor,
        [string]`$BackgroundColor,
        [switch]`$NoNewline
    )
    Write-Output `$Object
}

Function diskCheck {
    `$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='L:' or DeviceID='X:'" 
    If(`$disk) {
        Write-Output "SKIP:DiskConflict"
        Return
    }
    Write-Output "OK"
}
Function setDisk {
    Write-Host '=== Set disk online and assign letters ===' -ForegroundColor Cyan
    Set-Disk -number 1 -IsReadonly `$False -ErrorAction SilentlyContinue
    Set-Disk -number 1 -IsOffline `$false -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Set-Disk -number 2 -IsOffline `$false -ErrorAction SilentlyContinue
    Set-Disk -number 2 -IsReadonly `$False -ErrorAction SilentlyContinue
    
    Get-Partition -DiskNumber 1 | Set-Partition -NewDriveLetter l -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Get-Partition -DiskNumber 2 | Set-Partition -NewDriveLetter x -ErrorAction SilentlyContinue
    
    Set-Volume -DriveLetter X -NewFileSystemLabel "DATA" -ErrorAction SilentlyContinue
    Set-Volume -DriveLetter L -NewFileSystemLabel "LOGS" -ErrorAction SilentlyContinue
}
Function renameNICAndDisableIPv6 {
    Write-Host '=== Rename Network Adapter and Disable IPv6 ===' -ForegroundColor Cyan
    `$n = (Get-NetAdapter | Where-Object { `$_.Status -eq 'Up' })[0]
    if (`$n) {
        Rename-NetAdapter -Name `$n.Name -NewName 'Service' -ErrorAction SilentlyContinue
    }
    Disable-NetAdapterBinding -Name 'Service' -ComponentId ms_tcpip6 -ErrorAction SilentlyContinue
}

renameNICAndDisableIPv6
`$status = diskCheck
if (`$status -eq "SKIP:DiskConflict") {
    Write-Host "SKIPPING Disk Config: L: or X: drive already exists." -ForegroundColor Red
} else {
    setDisk
}
"@
                            Write-Host "     > [Server Provision] Initializing disk and network configuration on guest VM..." -ForegroundColor Yellow
                            Invoke-Command -Session $Session -ScriptBlock ([scriptblock]::Create($PrepScript)) -ErrorAction Stop | ForEach-Object {
                                Write-Host "       > GuestOS: $_" -ForegroundColor Gray
                            }

                            # 2. Dynamic BU software copy & build local install script
                            $TargetBU = $null
                            foreach ($prop in $RemoteInstall.buSoftwareMapping.PSObject.Properties) {
                                if ($prop.Name -eq $FinalBU) { $TargetBU = $prop.Name }
                            }
                            if ($null -eq $TargetBU) {
                                foreach ($prop in $RemoteInstall.buSoftwareMapping.PSObject.Properties) {
                                    if ($prop.Name -eq $RawBU) { $TargetBU = $prop.Name }
                                }
                            }
                            if ($null -eq $TargetBU) { $TargetBU = "Basic" }

                            $SelectedNames = $RemoteInstall.buSoftwareMapping.$TargetBU
                            if ($null -eq $SelectedNames -or $SelectedNames.Count -eq 0 -or ($SelectedNames -join '').Trim() -eq "") {
                                Write-Host "     > [Server Provision] Target BU [$TargetBU] has no mapping. Falling back to Basic..." -ForegroundColor Yellow
                                $TargetBU = "Basic"
                                $SelectedNames = $RemoteInstall.buSoftwareMapping.$TargetBU
                            }
                            Write-Host "     > [Server Provision] Target BU determined: [$TargetBU]" -ForegroundColor Green
                            
                            $SelectedSoftware = @()
                            foreach ($sw in $RemoteInstall.masterList) {
                                if ($SelectedNames -contains $sw.name) { $SelectedSoftware += $sw }
                            }
                            Write-Host "     > [Server Provision] Software list to install: ($($SelectedNames -join ', '))" -ForegroundColor Green

                            $InstallerScript = @"
function Write-Host {
    param(
        [Parameter(ValueFromPipeline=`$true, Position=0)]
        [string]`$Object,
        [string]`$ForegroundColor,
        [string]`$BackgroundColor,
        [switch]`$NoNewline
    )
    Write-Output `$Object
}

Function Run-Deployment {
    Write-Host "Starting software installation inside guest OS..." -ForegroundColor Yellow
"@

                            foreach ($sw in $SelectedSoftware) {
                                $SafeName = $sw.name -replace '[^a-zA-Z0-9]', '_'
                                $FullPath = if ($sw.path.StartsWith('\\') -or $sw.path.Contains(':')) { $sw.path } else { "$($RemoteInstall.nasPath)\$($sw.path)" }
                                $LeafName = Split-Path $FullPath -Leaf
                                
                                # Translate UNC to NASDrive if mapped
                                $ResolvePath = $FullPath
                                if ($RemoteInstall.nasPath -and $FullPath.StartsWith($RemoteInstall.nasPath, [System.StringComparison]::OrdinalIgnoreCase) -and (Get-PSDrive -Name "NASDrive" -ErrorAction SilentlyContinue)) {
                                    $RelativePath = $FullPath.Substring($RemoteInstall.nasPath.Length).TrimStart('\')
                                    $ResolvePath = "NASDrive:\$RelativePath"
                                    # Normalize backslashes for mapped drive provider
                                    $ResolvePath = $ResolvePath -replace '\\+', '\'
                                    $ResolvePath = $ResolvePath -replace 'NASDrive:\\', 'NASDrive:\'
                                }
                                
                                $IsScript = $LeafName -match '\.(bat|cmd|ps1)$'
                                
                                Write-Host "     > [Server Provision] Transferring package $($sw.name) to guest VM..." -ForegroundColor Yellow
                                if (Test-Path $ResolvePath) {
                                    if (Test-Path $ResolvePath -PathType Leaf) {
                                        if ($IsScript) {
                                            # It's a script installer. Copy the ENTIRE parent folder.
                                            $ParentPath = Split-Path $FullPath -Parent
                                            $FolderName = Split-Path $ParentPath -Leaf
                                            $DestDir = "X:\$FolderName"
                                            
                                            Write-Host "     > [Server Provision] Script package detected. Transferring ENTIRE parent folder [$FolderName] to guest VM..." -ForegroundColor Yellow
                                            try {
                                                # Pre-create directory on guest VM
                                                Invoke-Command -Session $Session -ScriptBlock {
                                                    param($path)
                                                    if (-not (Test-Path $path)) {
                                                        New-Item -ItemType Directory -Path $path -Force | Out-Null
                                                    }
                                                } -ArgumentList $DestDir -ErrorAction Stop

                                                # Copy folder contents recursively from authenticated UNC path using wildcard *
                                                $SourceWildcard = "$ParentPath\*"
                                                Write-Host "     > [Server Provision] Copying folder contents from [$SourceWildcard] to [$DestDir] on guest VM..." -ForegroundColor Yellow
                                                Copy-Item -Path $SourceWildcard -Destination $DestDir -Recurse -ToSession $Session -Force -ErrorAction Stop
                                                Write-Host "     > [Server Provision] Folder contents copied successfully! [OK]" -ForegroundColor Green
                                            } catch {
                                                Write-Host "     > [Server Provision] Warning: Folder copy failed: $($_.Exception.Message)" -ForegroundColor Yellow
                                            }
                                            
                                            $InstallerScript += @"
 
    Write-Host "=== Installing $($sw.name) (Script Package) ===" -ForegroundColor Cyan
    `$destFile = "X:\\$FolderName\\$LeafName"
    `$appArgs = "$($sw.args)"
    if (Test-Path `$destFile) {
        Write-Host "     > Running installer `$destFile `$appArgs (Working Dir: X:\\$FolderName) with 2-minute timeout"
        try {
            # Use cmd.exe /c for .bat/.cmd files to ensure proper execution in WinRM Session 0
            if (`$destFile -match '\.(bat|cmd)`$') {
                `$cmdArgs = "/c `"`"`$destFile`"`" `$appArgs"
                `$p = Start-Process -FilePath "cmd.exe" -ArgumentList `$cmdArgs -RedirectStandardOutput "`$env:TEMP\\install_out.log" -RedirectStandardError "`$env:TEMP\\install_err.log" -WorkingDirectory "X:\\$FolderName" -PassThru -NoNewWindow
            } else {
                `$p = Start-Process -FilePath `$destFile -ArgumentList `$appArgs -RedirectStandardOutput "`$env:TEMP\\install_out.log" -RedirectStandardError "`$env:TEMP\\install_err.log" -WorkingDirectory "X:\\$FolderName" -PassThru -NoNewWindow
            }
            if (`$p) {
                `$finished = `$p.WaitForExit(120000)
                if (-not `$finished) {
                    Write-Host "     > Warning: Installer did not complete within 2 minutes. Terminating process..." -ForegroundColor Yellow
                    `$p.Kill()
                } else {
                    Write-Host "     > Installer exited with code `$(`$p.ExitCode)"
                }
            } else {
                Write-Host "     > Error: Failed to start process for `$destFile" -ForegroundColor Red
            }
            # Output install logs for diagnostics
            if (Test-Path "`$env:TEMP\\install_out.log") {
                `$outLog = Get-Content "`$env:TEMP\\install_out.log" -ErrorAction SilentlyContinue
                if (`$outLog) { `$outLog | ForEach-Object { Write-Host "       stdout: `$_" } }
            }
            if (Test-Path "`$env:TEMP\\install_err.log") {
                `$errLog = Get-Content "`$env:TEMP\\install_err.log" -ErrorAction SilentlyContinue
                if (`$errLog) { `$errLog | ForEach-Object { Write-Host "       stderr: `$_" } }
            }
        } catch {
            Write-Host "     > Exception starting process: `$(`$_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "     > Script installer not found locally in guest OS: `$destFile" -ForegroundColor Red
    }
"@
                                        } else {
                                            # File copy over session
                                            $DestFile = "X:\$LeafName"
                                            Copy-Item -Path $ResolvePath -Destination $DestFile -ToSession $Session -Force -ErrorAction SilentlyContinue
                                            
                                            $InstallerScript += @"
 
    Write-Host "=== Installing $($sw.name) (Single File) ===" -ForegroundColor Cyan
    `$destFile = "X:\\$LeafName"
    `$appArgs = "$($sw.args)"
    if (Test-Path `$destFile) {
        Write-Host "     > Running installer `$destFile `$appArgs with 2-minute timeout"
        try {
            `$p = Start-Process -FilePath `$destFile -ArgumentList `$appArgs -RedirectStandardOutput "`$env:TEMP\\install_out.log" -RedirectStandardError "`$env:TEMP\\install_err.log" -PassThru -NoNewWindow
            if (`$p) {
                `$finished = `$p.WaitForExit(120000)
                if (-not `$finished) {
                    Write-Host "     > Warning: Installer did not complete within 2 minutes. Terminating process..." -ForegroundColor Yellow
                    `$p.Kill()
                } else {
                    Write-Host "     > Installer exited with code `$(`$p.ExitCode)"
                }
            } else {
                Write-Host "     > Error: Failed to start process for `$destFile" -ForegroundColor Red
            }
        } catch {
            Write-Host "     > Exception starting process: `$(`$_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "     > Installer not found locally in guest OS." -ForegroundColor Red
    }
"@
                                        }
                                    } else {
                                        # Directory copy over session
                                        $DestDir = "X:\$SafeName"
                                        try {
                                            # Pre-create directory on guest VM
                                            Invoke-Command -Session $Session -ScriptBlock {
                                                param($path)
                                                if (-not (Test-Path $path)) {
                                                    New-Item -ItemType Directory -Path $path -Force | Out-Null
                                                }
                                            } -ArgumentList $DestDir -ErrorAction Stop

                                            # Copy directory contents recursively using wildcard *
                                            $SourceWildcard = "$FullPath\*"
                                            Write-Host "     > [Server Provision] Copying directory contents from [$SourceWildcard] to [$DestDir] on guest VM..." -ForegroundColor Yellow
                                            Copy-Item -Path $SourceWildcard -Destination $DestDir -Recurse -ToSession $Session -Force -ErrorAction Stop
                                            Write-Host "     > [Server Provision] Directory contents copied successfully! [OK]" -ForegroundColor Green
                                        } catch {
                                            Write-Host "     > [Server Provision] Warning: Directory copy failed: $($_.Exception.Message)" -ForegroundColor Yellow
                                        }
                                        
                                        $InstallerScript += @"
 
    Write-Host "=== Copying $($sw.name) (Folder) ===" -ForegroundColor Cyan
    `$destDir = "X:\\$SafeName"
    if (Test-Path `$destDir) {
        Write-Host "     > Folder copied to `$destDir"
    } else {
        Write-Host "     > Target folder not found in guest OS." -ForegroundColor Red
    }
"@
                                    }
                                    Write-Host "     > [Server Provision] Package $($sw.name) transferred successfully! [OK]" -ForegroundColor Green
                                } else {
                                    Write-Host "     > [Server Provision] Warning: Source path not found on NAS: $FullPath (Resolved Path: $ResolvePath)" -ForegroundColor Yellow
                                    $InstallerScript += @"
 
    Write-Host "=== $($sw.name) skipped (source not found) ===" -ForegroundColor Yellow
"@
                                }
                            }

    $SafeJoinPass = $JoinPass -replace "'", "''"
    $TargetDomain = if ($AllowedADDomain) { $AllowedADDomain } else { $LoopZone }

    $InstallerScript += @"
 
    Write-Host "=== Joining Active Directory Domain ($LoopZone) ===" -ForegroundColor Cyan
    `$SecPass = ConvertTo-SecureString '$SafeJoinPass' -AsPlainText -Force
    `$Cred = New-Object System.Management.Automation.PSCredential ('$JoinUser@$TargetDomain', `$SecPass)
    try {
        Add-Computer -DomainName '$LoopZone' -OUPath '$TargetDN' -Credential `$Cred -Force -Options AccountCreate -ErrorAction Stop
        Write-Host "     > Successfully joined domain: $LoopZone (OU: $TargetDN)" -ForegroundColor Green
    } catch {
        Write-Host "     > [ERROR] Failed to join domain $LoopZone : `$(`$_.Exception.Message)" -ForegroundColor Red
    }

    Write-Host "Post-setup deployment complete!" -ForegroundColor Green
}
Run-Deployment
"@

                            # 3. Invoke Guest OS local software execution
                            try {
                                Write-Host "     > [Server Provision] Running software installation pipeline inside the guest VM..." -ForegroundColor Yellow
                                Invoke-Command -Session $Session -ScriptBlock ([scriptblock]::Create($InstallerScript)) -ErrorAction Stop | ForEach-Object {
                                    Write-Host "       > GuestOS: $_" -ForegroundColor Gray
                                }
                                Write-Host "     > [Server Provision] Software installation completed successfully!" -ForegroundColor Green
                            } catch {
                                Write-Host "     > [Server Provision] Error during guest execution: $_" -ForegroundColor Red
                            }

                            # 4. Graceful ACPI Shutdown inside guest OS via WinRM
                            try {
                                Write-Host "     > [Server Provision] Initiating clean graceful shutdown inside guest OS..." -ForegroundColor Yellow
                                Invoke-Command -Session $Session -ScriptBlock { shutdown.exe /s /t 2 /f } -ErrorAction SilentlyContinue
                            } catch {
                                Write-Host "     > Warning: Shutdown request failed: $_" -ForegroundColor Yellow
                            } finally {
                                Remove-PSSession $Session -ErrorAction SilentlyContinue
                            }
                        } else {
                            Write-Host "     > Warning: Failed to connect to guest VM via WinRM. Server Provisioning skipped." -ForegroundColor Yellow
                            Write-Host "     > [CRITICAL] Bypassing CD-ROM ejection to prevent interrupting Sysprep/Windows Setup." -ForegroundColor Yellow
                            $SkipEject = $true
                        }

                        if (-not $SkipEject) {
                            # Now the VM is turning off or is off. We do the ejection and boot ON:
                            # 5. Wait for VM state to transition to OFF on PC
                            Write-Host "   [$CurrentName] Monitoring guest OS shutdown status..." -ForegroundColor Cyan
                            $PowerOffReady = $false
                        $PowerRetry = 0
                        $MaxPowerRetry = 30 # wait up to 2.5 minutes
                        
                        do {
                            $PowerRetry++
                            Start-Sleep -Seconds 5
                            try {
                                $VmCheck = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                                if ($VmCheck.status.resources.power_state -eq "OFF") {
                                    $PowerOffReady = $true
                                    Write-Host "     > VM is powered OFF cleanly! [OK]" -ForegroundColor Green
                                }
                            } catch {
                                Write-Host "     > Warning checking power state: $_" -ForegroundColor Yellow
                            }
                        } until ($PowerOffReady -or $PowerRetry -ge $MaxPowerRetry)

                        if (-not $PowerOffReady) {
                            Write-Host "     > Warning: Clean shutdown timed out. Forcing virtual shutdown for ejection..." -ForegroundColor Yellow
                            $ForceOffSuccess = $false
                            $ForceOffRetries = 0
                            $MaxForceOffRetries = 5
                            do {
                                $ForceOffRetries++
                                if ($ForceOffRetries -gt 1) {
                                    Write-Host "     > [Retry $ForceOffRetries/$MaxForceOffRetries] Force shutdown conflict. Retrying in 5 seconds..." -ForegroundColor Yellow
                                    Start-Sleep -Seconds 5
                                }
                                try {
                                    $ForceOffDetail = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                                    $ForceOffDetail.spec.resources.power_state = "OFF"
                                    $ForceBody = @{ "spec" = $ForceOffDetail.spec; "metadata" = $ForceOffDetail.metadata } | ConvertTo-Json -Depth 10
                                    $ForceRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $ForceBody
                                    $ForceTaskUUID = $ForceRes.task_uuid
                                    if ($ForceTaskUUID) {
                                        do {
                                            Start-Sleep -Seconds 2
                                            $ForceTaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$ForceTaskUUID" -Method Get -Headers $Headers
                                        } while ($ForceTaskInfo.status -eq "RUNNING" -or $ForceTaskInfo.status -eq "QUEUED")
                                    }
                                    $ForceOffSuccess = $true
                                } catch {
                                    $ErrText = $_.Exception.Message
                                    if ($_.Exception.Response) {
                                        try {
                                            $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                                            $Reader.BaseStream.Position = 0
                                            $ErrText = $Reader.ReadToEnd()
                                        } catch {}
                                    }
                                    Write-Host "     > Warning forcing shutdown: $ErrText" -ForegroundColor Yellow
                                    if ($ErrText -match "CONCURRENT_REQUESTS_NOT_ALLOWED" -or $ErrText -match "409" -or $ErrText -match "conflict") {
                                        # Retry
                                    } else {
                                        break
                                    }
                                }
                            } while (-not $ForceOffSuccess -and $ForceOffRetries -lt $MaxForceOffRetries)
                        }

                        # 6. Remove Sysprep CD-ROM device (ide.1) from disk_list; keep ide.0
                        Write-Host "   [$CurrentName] Removing Sysprep CD-ROM (ide.1) from VM configuration..." -ForegroundColor Cyan
                        
                        $Ejected = $false
                        $EjectRetries = 0
                        $MaxEjectRetries = 5
                        
                        do {
                            $EjectRetries++
                            if ($EjectRetries -gt 1) {
                                Write-Host "     > [Retry $EjectRetries/$MaxEjectRetries] Edit conflict encountered. Retrying in 5 seconds..." -ForegroundColor Yellow
                                Start-Sleep -Seconds 5
                            } else {
                                # Initial sleep after power OFF to let PC database settle
                                Start-Sleep -Seconds 3
                            }
                            
                            try {
                                $VmDetailOff = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                                $VmSpecOff = $VmDetailOff.spec
                                $VmMetaOff = $VmDetailOff.metadata
                                $NeedEject = $false
                                
                                # Build new disk list: remove CDROM at ide.1 (Sysprep), keep ide.0
                                $NewDiskList = @()
                                foreach ($disk in $VmSpecOff.resources.disk_list) {
                                    if ($disk.device_properties.device_type -eq "CDROM" -and $disk.device_properties.disk_address.device_index -eq 1) {
                                        # Skip this device entirely - remove Sysprep CD-ROM (ide.1)
                                        $NeedEject = $true
                                        Write-Host "     > Found Sysprep CD-ROM at ide.1 - removing from disk_list" -ForegroundColor DarkGray
                                        continue
                                    }
                                    $NewDiskList += $disk
                                }
                                $VmSpecOff.resources.disk_list = $NewDiskList
                                
                                if ($NeedEject) {
                                    $EjectPayload = @{ "spec" = $VmSpecOff; "metadata" = $VmMetaOff } | ConvertTo-Json -Depth 10
                                    $EjectRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $EjectPayload
                                    
                                    $EjectTaskUUID = $EjectRes.task_uuid
                                    if ($EjectTaskUUID) {
                                        do {
                                            Start-Sleep -Seconds 2
                                            $EjectTaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$EjectTaskUUID" -Method Get -Headers $Headers
                                        } while ($EjectTaskInfo.status -eq "RUNNING" -or $EjectTaskInfo.status -eq "QUEUED")
                                    }
                                    Write-Host "     > Sysprep CD-ROM (ide.1) removed successfully! [OK]" -ForegroundColor Green
                                } else {
                                    Write-Host "     > No Sysprep CD-ROM (ide.1) found to remove." -ForegroundColor Gray
                                }
                                $Ejected = $true
                            } catch {
                                $ErrText = $_.Exception.Message
                                if ($_.Exception.Response) {
                                    try {
                                        $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                                        $Reader.BaseStream.Position = 0
                                        $ErrText = $Reader.ReadToEnd()
                                    } catch {}
                                }
                                Write-Host "     > Warning during CD-ROM ejection attempt: $ErrText" -ForegroundColor Yellow
                                
                                if ($ErrText -match "CONCURRENT_REQUESTS_NOT_ALLOWED" -or $ErrText -match "409" -or $ErrText -match "conflict") {
                                    # Loop back and retry with fresh spec_version
                                } else {
                                    Write-Host "     > Non-conflict error. Aborting ejection retries." -ForegroundColor Red
                                    break
                                }
                            }
                        } while (-not $Ejected -and $EjectRetries -lt $MaxEjectRetries)
                        
                        if (-not $Ejected) {
                            Write-Host "     > Error: Failed to eject CD-ROM after $MaxEjectRetries attempts." -ForegroundColor Red
                        }

                        # 7. Boot VM back ON
                        Write-Host "   [$CurrentName] Booting VM back ON after customization and ejection..." -ForegroundColor Cyan
                        
                        $Booted = $false
                        $BootRetries = 0
                        $MaxBootRetries = 5
                        
                        do {
                            $BootRetries++
                            if ($BootRetries -gt 1) {
                                Write-Host "     > [Retry $BootRetries/$MaxBootRetries] Edit conflict encountered. Retrying in 5 seconds..." -ForegroundColor Yellow
                                Start-Sleep -Seconds 5
                            } else {
                                # Initial sleep after CD-ROM removal to let PC database settle spec_version
                                Start-Sleep -Seconds 8
                            }
                            
                            try {
                                $VmDetailFinal = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                                $VmSpecFinal = $VmDetailFinal.spec
                                $VmMetaFinal = $VmDetailFinal.metadata
                                
                                $VmSpecFinal.resources.power_state = "ON"
                                $BootPayload = @{ "spec" = $VmSpecFinal; "metadata" = $VmMetaFinal } | ConvertTo-Json -Depth 10
                                $BootRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $BootPayload
                                
                                $BootTaskUUID = $BootRes.task_uuid
                                if ($BootTaskUUID) {
                                    do {
                                        Start-Sleep -Seconds 2
                                        $BootTaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$BootTaskUUID" -Method Get -Headers $Headers
                                    } while ($BootTaskInfo.status -eq "RUNNING" -or $BootTaskInfo.status -eq "QUEUED")
                                }
                                Write-Host "     > VM is booted up and ready! [OK]" -ForegroundColor Green
                                Write-Host "     > Provisioning, server customization, and eject completed successfully! [SUCCESS]" -ForegroundColor Green
                                $Booted = $true
                            } catch {
                                $ErrText = $_.Exception.Message
                                if ($_.Exception.Response) {
                                    try {
                                        $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                                        $Reader.BaseStream.Position = 0
                                        $ErrText = $Reader.ReadToEnd()
                                    } catch {}
                                }
                                Write-Host "     > Warning during boot attempt: $ErrText" -ForegroundColor Yellow
                                
                                if ($ErrText -match "CONCURRENT_REQUESTS_NOT_ALLOWED" -or $ErrText -match "409" -or $ErrText -match "conflict") {
                                    # Loop back and retry with fresh spec_version
                                } else {
                                    Write-Host "     > Non-conflict error. Aborting boot retries." -ForegroundColor Red
                                    break
                                }
                            }
                            } while (-not $Booted -and $BootRetries -lt $MaxBootRetries)
                            
                            if (-not $Booted) {
                                Write-Host "     > Error: Failed to boot VM back ON after $MaxBootRetries attempts." -ForegroundColor Red
                            }
                        }

            } else {
                # Linux provisioning flow
                Write-Host "   [$CurrentName] Bypassing Active Directory monitoring, OU movement, and guest software installation (Linux VM flow)." -ForegroundColor Cyan
                if ($PortReady) {
                    Write-Host "   [$CurrentName] Linux VM is up and reachable! Hostname, static IP configuration, and firewall disabling completed via Cloud-Init. [SUCCESS]" -ForegroundColor Green
                } else {
                    Write-Host "   [$CurrentName] Warning: SSH probe timed out, but Linux VM clone was dispatched. Please check VM console. [WARNING]" -ForegroundColor Yellow
                }

                # Virtually shutdown Linux VM to eject CD-ROM (ide.1)
                Write-Host "   [$CurrentName] Initiating virtual shutdown to eject Cloud-Init CD-ROM..." -ForegroundColor Yellow
                $LinuxOffSuccess = $false
                $LinuxOffRetries = 0
                $MaxLinuxOffRetries = 5
                do {
                    $LinuxOffRetries++
                    if ($LinuxOffRetries -gt 1) {
                        Write-Host "     > [Retry $LinuxOffRetries/$MaxLinuxOffRetries] Shutdown conflict. Retrying in 5 seconds..." -ForegroundColor Yellow
                        Start-Sleep -Seconds 5
                    }
                    try {
                        $OffDetail = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                        $OffDetail.spec.resources.power_state = "OFF"
                        $OffBody = @{ "spec" = $OffDetail.spec; "metadata" = $OffDetail.metadata } | ConvertTo-Json -Depth 10
                        $OffRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $OffBody
                        $OffTaskUUID = $OffRes.task_uuid
                        if ($OffTaskUUID) {
                            do {
                                Start-Sleep -Seconds 2
                                $OffTaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$OffTaskUUID" -Method Get -Headers $Headers
                            } while ($OffTaskInfo.status -eq "RUNNING" -or $OffTaskInfo.status -eq "QUEUED")
                        }
                        $LinuxOffSuccess = $true
                    } catch {
                        $ErrText = $_.Exception.Message
                        if ($_.Exception.Response) {
                            try {
                                $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                                $Reader.BaseStream.Position = 0
                                $ErrText = $Reader.ReadToEnd()
                            } catch {}
                        }
                        Write-Host "     > Warning forcing shutdown: $ErrText" -ForegroundColor Yellow
                        if ($ErrText -match "CONCURRENT_REQUESTS_NOT_ALLOWED" -or $ErrText -match "409" -or $ErrText -match "conflict") {
                            # Retry
                        } else {
                            break
                        }
                    }
                } while (-not $LinuxOffSuccess -and $LinuxOffRetries -lt $MaxLinuxOffRetries)

                # Wait for power state to transition to OFF on PC
                Write-Host "   [$CurrentName] Monitoring Linux guest OS shutdown status..." -ForegroundColor Cyan
                $PowerOffReady = $false
                $PowerRetry = 0
                $MaxPowerRetry = 30
                do {
                    $PowerRetry++
                    Start-Sleep -Seconds 5
                    try {
                        $VmCheck = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                        if ($VmCheck.status.resources.power_state -eq "OFF") {
                            $PowerOffReady = $true
                            Write-Host "     > VM is powered OFF cleanly! [OK]" -ForegroundColor Green
                        }
                    } catch {
                        Write-Host "     > Warning checking power state: $_" -ForegroundColor Yellow
                    }
                } until ($PowerOffReady -or $PowerRetry -ge $MaxPowerRetry)

                # Remove Cloud-Init CD-ROM device (ide.1) from disk_list
                Write-Host "   [$CurrentName] Removing Cloud-Init CD-ROM (ide.1) from VM configuration..." -ForegroundColor Cyan
                $Ejected = $false
                $EjectRetries = 0
                $MaxEjectRetries = 5
                do {
                    $EjectRetries++
                    if ($EjectRetries -gt 1) {
                        Write-Host "     > [Retry $EjectRetries/$MaxEjectRetries] Edit conflict encountered. Retrying in 5 seconds..." -ForegroundColor Yellow
                        Start-Sleep -Seconds 5
                    } else {
                        Start-Sleep -Seconds 3
                    }
                    try {
                        $VmDetailOff = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                        $VmSpecOff = $VmDetailOff.spec
                        $VmMetaOff = $VmDetailOff.metadata
                        $NeedEject = $false
                        $NewDiskList = @()
                        foreach ($disk in $VmSpecOff.resources.disk_list) {
                            if ($disk.device_properties.device_type -eq "CDROM" -and $disk.device_properties.disk_address.device_index -eq 1) {
                                $NeedEject = $true
                                Write-Host "     > Found CD-ROM at ide.1 - removing from disk_list" -ForegroundColor DarkGray
                                continue
                            }
                            $NewDiskList += $disk
                        }
                        $VmSpecOff.resources.disk_list = $NewDiskList
                        if ($NeedEject) {
                            $EjectPayload = @{ "api_version" = "3.1"; "spec" = $VmSpecOff; "metadata" = $VmMetaOff } | ConvertTo-Json -Depth 10
                            $EjectRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $EjectPayload
                            $EjectTaskUUID = $EjectRes.task_uuid
                            if ($EjectTaskUUID) {
                                do {
                                    Start-Sleep -Seconds 2
                                    $EjectTaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$EjectTaskUUID" -Method Get -Headers $Headers
                                } while ($EjectTaskInfo.status -eq "RUNNING" -or $EjectTaskInfo.status -eq "QUEUED")
                            }
                            Write-Host "     > Cloud-Init CD-ROM (ide.1) removed successfully! [OK]" -ForegroundColor Green
                        } else {
                            Write-Host "     > No CD-ROM (ide.1) found to remove." -ForegroundColor Gray
                        }
                        $Ejected = $true
                    } catch {
                        $ErrText = $_.Exception.Message
                        if ($_.Exception.Response) {
                            try {
                                $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                                $Reader.BaseStream.Position = 0
                                $ErrText = $Reader.ReadToEnd()
                            } catch {}
                        }
                        Write-Host "     > Warning during CD-ROM ejection attempt: $ErrText" -ForegroundColor Yellow
                        if ($ErrText -match "CONCURRENT_REQUESTS_NOT_ALLOWED" -or $ErrText -match "409" -or $ErrText -match "conflict") {
                            # Retry
                        } else {
                            break
                        }
                    }
                } while (-not $Ejected -and $EjectRetries -lt $MaxEjectRetries)

                # Boot VM back ON
                Write-Host "   [$CurrentName] Booting VM back ON after ejection..." -ForegroundColor Cyan
                $Booted = $false
                $BootRetries = 0
                $MaxBootRetries = 5
                do {
                    $BootRetries++
                    if ($BootRetries -gt 1) {
                        Write-Host "     > [Retry $BootRetries/$MaxBootRetries] Edit conflict encountered. Retrying in 5 seconds..." -ForegroundColor Yellow
                        Start-Sleep -Seconds 5
                    } else {
                        Start-Sleep -Seconds 8
                    }
                    try {
                        $VmDetailFinal = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Get -Headers $Headers
                        $VmSpecFinal = $VmDetailFinal.spec
                        $VmMetaFinal = $VmDetailFinal.metadata
                        $VmSpecFinal.resources.power_state = "ON"
                        $BootPayload = @{ "api_version" = "3.1"; "spec" = $VmSpecFinal; "metadata" = $VmMetaFinal } | ConvertTo-Json -Depth 10
                        $BootRes = Invoke-RestMethod -Uri "$BaseUrl/vms/$NewVMUUID" -Method Put -Headers $Headers -Body $BootPayload
                        $BootTaskUUID = $BootRes.task_uuid
                        if ($BootTaskUUID) {
                            do {
                                Start-Sleep -Seconds 2
                                $BootTaskInfo = Invoke-RestMethod -Uri "$BaseUrl/tasks/$BootTaskUUID" -Method Get -Headers $Headers
                            } while ($BootTaskInfo.status -eq "RUNNING" -or $BootTaskInfo.status -eq "QUEUED")
                        }
                        Write-Host "     > Linux VM is booted back ON and fully customized! [SUCCESS]" -ForegroundColor Green
                        $Booted = $true
                    } catch {
                        $ErrText = $_.Exception.Message
                        if ($_.Exception.Response) {
                            try {
                                $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                                $Reader.BaseStream.Position = 0
                                $ErrText = $Reader.ReadToEnd()
                            } catch {}
                        }
                        Write-Host "     > Warning during boot attempt: $ErrText" -ForegroundColor Yellow
                        if ($ErrText -match "CONCURRENT_REQUESTS_NOT_ALLOWED" -or $ErrText -match "409" -or $ErrText -match "conflict") {
                            # Retry
                        } else {
                            break
                        }
                    }
                } while (-not $Booted -and $BootRetries -lt $MaxBootRetries)
            }

        } else {
            Write-Host "Error: [$CurrentName] Nutanix VM Clone task failed: $($TaskInfo.error_detail)" -ForegroundColor Red
        }

    } catch {
        Write-Host "Error: [$CurrentName] Runtime exception caught in workflow block: $_" -ForegroundColor Red
    }
}

# 4. Dispatch background jobs with throttle limit of 5
$ThrottleLimit = 5
$Jobs = @()

# Serialize shared data to JSON strings for passing into jobs
$HeadersJsonStr = $NutanixHeaders | ConvertTo-Json -Compress
$IPSwitchMapJsonStr = $IPSwitchMap | ConvertTo-Json -Depth 5 -Compress
$TemplateBUMapJsonStr = if ($TemplateBUMap) { $TemplateBUMap | ConvertTo-Json -Depth 5 -Compress } else { "[]" }
$RemoteInstallConfigJsonStr = if ($Params.RemoteInstallConfig) { $Params.RemoteInstallConfig | ConvertTo-Json -Depth 5 -Compress } else { "{}" }

foreach ($VMItem in $BatchList) {
    # Throttle: wait if we already have $ThrottleLimit running jobs
    while (($Jobs | Where-Object { $_.State -eq 'Running' }).Count -ge $ThrottleLimit) {
        # Stream output from all running/completed jobs while waiting
        foreach ($j in $Jobs) {
            if ($j.HasMoreData) {
                Receive-Job -Job $j
            }
        }
        Start-Sleep -Seconds 2
    }

    $VMJsonStr = $VMItem | ConvertTo-Json -Depth 5 -Compress
    Write-Host "   [Dispatcher] Launching background job for VM: $($VMItem.Name)" -ForegroundColor DarkCyan

    $job = Start-Job -ScriptBlock $WorkerScriptBlock -ArgumentList @(
        $VMJsonStr,
        $HeadersJsonStr,
        $BaseUrl,
        $JoinUser,
        $JoinPass,
        $AllowedADDomain,
        $LocalAdminPass,
        $LinuxAdminPass,
        $IPSwitchMapJsonStr,
        $RemoteInstallConfigJsonStr,
        $TemplateBUMapJsonStr
    )
    $Jobs += $job
}

# 5. Wait for all remaining jobs to complete and stream output in real-time
Write-Host ""
Write-Host "All $($Jobs.Count) provisioning jobs dispatched. Streaming progress..." -ForegroundColor Yellow
Write-Host ""

while (($Jobs | Where-Object { $_.State -eq 'Running' }).Count -gt 0) {
    foreach ($job in $Jobs) {
        if ($job.HasMoreData) {
            Receive-Job -Job $job
        }
    }
    Start-Sleep -Seconds 2
}

# Final collection for any leftover data
foreach ($job in $Jobs) {
    Receive-Job -Job $job
    Remove-Job -Job $job
}

Write-Host ""
Write-Host "All provisioning actions completed! Windows Server boot up sequence takes ~1-2 minutes." -ForegroundColor Yellow
