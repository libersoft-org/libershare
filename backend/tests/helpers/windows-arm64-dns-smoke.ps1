$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'Arm64') {
    throw 'This fixture requires the disposable native Windows ARM64 CI runner'
}
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Creating the isolated test adapter requires administrator rights'
}
$inf = Join-Path $env:SystemRoot 'INF\netloop.inf'
if (-not (Test-Path -LiteralPath $inf)) { throw 'The inbox Microsoft loopback driver is unavailable' }
if (@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.HardwareID -contains '*MSLOOP' }).Count) {
    throw 'An existing Microsoft loopback device prevents isolated driver installation'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class DnsLoopbackFixture : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    struct DeviceInfo {
        public uint Size;
        public Guid ClassGuid;
        public uint DevInst;
        public UIntPtr Reserved;
    }
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid guid, IntPtr parent);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiCreateDeviceInfoW(IntPtr list, string name, ref Guid guid, string description, IntPtr parent, uint flags, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr list, ref DeviceInfo device, uint property, byte[] value, uint size);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiCallClassInstaller(uint operation, IntPtr list, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiGetDeviceInstanceIdW(IntPtr list, ref DeviceInfo device, StringBuilder id, uint size, out uint required);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr list);
    [DllImport("newdev.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr parent, string hardwareId, string inf, uint flags, out bool reboot);

    IntPtr list = new IntPtr(-1);
    DeviceInfo device;
    bool registered;
    public string InstanceId { get; private set; }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    public DnsLoopbackFixture(string inf) {
        try {
            var guid = new Guid("4d36e972-e325-11ce-bfc1-08002be10318");
            device.Size = (uint)Marshal.SizeOf(typeof(DeviceInfo));
            list = SetupDiCreateDeviceInfoList(ref guid, IntPtr.Zero);
            Check(list != new IntPtr(-1));
            Check(SetupDiCreateDeviceInfoW(list, "Net", ref guid, "Native DNS test loopback", IntPtr.Zero, 1, ref device));
            byte[] hardwareId = Encoding.Unicode.GetBytes("*MSLOOP\0\0");
            Check(SetupDiSetDeviceRegistryPropertyW(list, ref device, 1, hardwareId, (uint)hardwareId.Length));
            Check(SetupDiCallClassInstaller(0x19, list, ref device));
            registered = true;
            var id = new StringBuilder(512);
            uint required;
            Check(SetupDiGetDeviceInstanceIdW(list, ref device, id, (uint)id.Capacity, out required));
            InstanceId = id.ToString();
            bool reboot;
            Check(UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, "*MSLOOP", inf, 5, out reboot));
            if (reboot) throw new InvalidOperationException("Loopback driver installation requires a reboot");
        } catch { Dispose(); throw; }
    }
    public void Dispose() {
        if (list == new IntPtr(-1)) return;
        try {
            if (registered) {
                Check(SetupDiCallClassInstaller(5, list, ref device));
                registered = false;
            }
        } finally {
            SetupDiDestroyDeviceInfoList(list);
            list = new IntPtr(-1);
        }
    }
}
'@

function Read-OtherDns([int]$excludeIndex) {
    $rows = @(Get-DnsClientServerAddress | Where-Object InterfaceIndex -ne $excludeIndex |
        Sort-Object InterfaceIndex, AddressFamily | Select-Object InterfaceIndex, AddressFamily, ServerAddresses)
    ConvertTo-Json -InputObject $rows -Depth 4 -Compress
}

$fixture = $null
$otherDns = $null
$adapter = $null
try {
    $fixture = [DnsLoopbackFixture]::new($inf)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $adapter = @(Get-NetAdapter -IncludeHidden | Where-Object PnPDeviceID -eq $fixture.InstanceId)
        if ($adapter.Count -eq 1) { break }
        Start-Sleep -Seconds 1
    }
    if ($adapter.Count -ne 1) { throw 'The newly created loopback adapter did not appear' }
    $adapter = $adapter[0]
    $otherDns = Read-OtherDns $adapter.ifIndex
    Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -Dhcp Disabled -InterfaceMetric 9999
    New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress '192.0.2.10' -PrefixLength 32 -SkipAsSource $true | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $address = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress '192.0.2.10'
        if ($address.AddressState -eq 'Preferred') { break }
        Start-Sleep -Seconds 1
    }
    if ($address.AddressState -ne 'Preferred') { throw 'The isolated fixture address is not usable' }
    $env:WINDOWS_DNS_FIXTURE_GUID = ([Guid]$adapter.InterfaceGuid).ToString('B')
    $env:WINDOWS_DNS_FIXTURE_INSTANCE = $fixture.InstanceId
    & bun (Join-Path $PSScriptRoot 'windows-arm64-dns-smoke.ts')
    if ($LASTEXITCODE -ne 0) { throw "Native DNS smoke failed with exit code $LASTEXITCODE" }
} finally {
    try {
        if ($null -ne $otherDns -and (Read-OtherDns $adapter.ifIndex) -cne $otherDns) {
            throw 'DNS changed on an adapter outside the isolated fixture'
        }
        if ($null -ne $otherDns) { Write-Output 'Other adapter DNS policies unchanged' }
    } finally {
        if ($null -ne $fixture) {
            $instanceId = $fixture.InstanceId
            $fixture.Dispose()
            if (@(Get-NetAdapter -IncludeHidden | Where-Object PnPDeviceID -eq $instanceId).Count) {
                throw 'The isolated loopback adapter was not removed'
            }
            Write-Output 'Isolated loopback adapter removed'
        }
    }
}
