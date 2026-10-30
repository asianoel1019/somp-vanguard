# Scout-Linux RPM Packaging Guide

本文件說明如何將 Scout Linux Agent (Go) 打包為 RPM 安裝檔。

## 1. 準備環境 (CentOS / RHEL / Rocky Linux)
在打包機上安裝必要的工具：
```bash
sudo yum install -y rpm-build golang
```

## 2. 建立目錄結構
```bash
mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
```

## 3. 準備原始碼
將 `scout-linux` 目錄內容複製到 `~/rpmbuild/SOURCES/scout-1.0.2/`，並壓縮為 tar.gz：
```bash
cd ~/rpmbuild/SOURCES
mkdir scout-1.0.2
# 將 main.go、logtail.go 與 go.mod 放進 scout-1.0.2
# 撰寫 scout.service 並放進去（參考下方內容）
# 撰寫 config.json 放進去
tar -czvf scout-1.0.2.tar.gz scout-1.0.2/
```

### scout.service
```ini
[Unit]
Description=Scout Monitor Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/scout
Restart=on-failure
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
```

### config.json
```json
{
  "backendUrl": "http://198.51.100.98:8080",
  "apiKey": "sk-scout-YOUR_API_KEY",
  "reportInterval": 60,
  "watchProcesses": ["nginx", "dockerd"],
  "pingTargets": ["8.8.8.8"],
  "tcpTargets": ["10.0.0.1:3306"]
}
```

> **💡 關於 `apiKey`：**
> API Key 是由後端自動產生的。請先登入系統的 Web 介面，進入 **Monitor Dashboard -> Hosts Management** 分頁，點擊「**+ Add Host**」新增這台主機。新增成功後，列表中會出現該主機的 API Key，點擊「**Copy Key**」按鈕複製後，貼上至此設定檔的 `apiKey` 欄位中即可。

## 4. 撰寫 SPEC 檔
建立 `~/rpmbuild/SPECS/scout.spec`：
```spec
%define _binary_payload w2.xzdio

Name:           scout
Version:        1.0.2
Release:        1%{?dist}
Summary:        Scout Monitor Agent

License:        MIT
Source0:        %{name}-%{version}.tar.gz

BuildRequires:  golang
Requires:       systemd coreutils

%description
Scout Monitor Agent for Linux. Reports CPU, memory, and disk metrics.

%prep
%setup -q

%build
CGO_ENABLED=0 go build -o scout main.go logtail.go

%install
rm -rf $RPM_BUILD_ROOT
# Install binary
install -d -m 0755 $RPM_BUILD_ROOT/usr/bin
install -m 0755 scout $RPM_BUILD_ROOT/usr/bin/scout

# Install config
install -d -m 0755 $RPM_BUILD_ROOT/etc/scout
install -m 0644 config.json $RPM_BUILD_ROOT/etc/scout/config.json

# Install systemd service
install -d -m 0755 $RPM_BUILD_ROOT/etc/systemd/system
install -m 0644 scout.service $RPM_BUILD_ROOT/etc/systemd/system/scout.service

%clean
rm -rf $RPM_BUILD_ROOT

%files
/usr/bin/scout
%config(noreplace) /etc/scout/config.json
/etc/systemd/system/scout.service

%post
systemctl daemon-reload
systemctl enable scout
# Auto-restart on upgrade
if [ $1 -eq 2 ]; then
    systemctl try-restart scout || true
fi

%preun
if [ $1 -eq 0 ]; then
    systemctl stop scout
    systemctl disable scout
fi

%postun
if [ $1 -eq 0 ]; then
    systemctl daemon-reload
fi

%changelog
* Fri Jul 03 2026 SysOp Admin <admin@vanguard.com> - 1.0.2-1
- Upgrade to 1.0.2: Incorporate log tailing and timeout remediations
* Tue Jun 23 2026 SysOp Admin <admin@vanguard.com> - 1.0.0-1
- Initial release of Scout Monitor Agent
```

## 5. 打包 RPM
```bash
rpmbuild -ba ~/rpmbuild/SPECS/scout.spec
```

打包完成後，RPM 檔會產生在 `~/rpmbuild/RPMS/x86_64/scout-1.0.2-1.el10.x86_64.rpm` (檔名依作業系統與版本可能略有不同)。

## 6. 安裝與啟動
將 RPM 檔傳送至目標主機後：
```bash
sudo rpm -ivh scout-1.0.2-1.el10.x86_64.rpm
# 修改 /etc/scout/config.json 設定正確 the backendUrl 與 apiKey
sudo vi /etc/scout/config.json
sudo systemctl restart scout
sudo systemctl status scout
```
