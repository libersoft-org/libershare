import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** An IPv4 address as the fake host holds it, with the stores it lives in. */
export interface FakeAddress {
	IPAddress: string;
	PrefixLength: number;
	PrefixOrigin?: string;
	SuffixOrigin?: string;
	SkipAsSource?: boolean;
	ValidLifetime?: string;
	PreferredLifetime?: string;
	Type?: string;
	Stores: string[];
}

/** An IPv4 default route as the fake host holds it. */
export interface FakeRoute {
	NextHop: string;
	RouteMetric: number;
	Protocol?: string;
	Publish?: string;
	ValidLifetime?: string;
	PreferredLifetime?: string;
	Stores: string[];
}

/** The host the generated script is run against. */
export interface FakeHost {
	guid: string;
	dhcp: 'Enabled' | 'Disabled';
	addresses: FakeAddress[];
	routes: FakeRoute[];
	/** The interface's static NameServer registry value — empty when DNS is automatic. */
	nameServer?: string;
	/** Name of the stub whose FIRST call throws, so a mid-apply failure can be provoked. */
	failOn?: string;
	/** AddressState the stub reports for a freshly created address (4 = Preferred). */
	newAddressState?: number;
}

/** What the run left behind, and every stub it went through on the way. */
export interface HarnessResult {
	/** One entry per stub call, in order, as `Cmdlet` or `Cmdlet:Store`. */
	calls: string[];
	addresses: FakeAddress[];
	routes: FakeRoute[];
	dhcp: string;
	dns: string[];
	/** The message the script failed with, or null when it succeeded. */
	error: string | null;
}

/** Infinite, as Windows reports it — the lifetime of anything not handed out by a lease. */
export const INFINITE_LIFETIME = '10675199.02:48:05.4775807';

/**
 * PowerShell functions shadowing every Net* cmdlet the apply calls.
 *
 * A function wins over a cmdlet of the same name, so the generated script runs
 * unmodified against these. Each one models the property the apply actually
 * depends on — above all POLICY STORE MEMBERSHIP, which is why a reading of one
 * store and a write to two cannot be caught by inspecting the script text.
 *
 * Every named parameter the script passes has to be declared: an undeclared one
 * is a binding error rather than a silently ignored argument, which is itself a
 * useful check that the script only passes parameters the real cmdlets accept.
 */
const STUBS = String.raw`
$ErrorActionPreference = 'Stop'
$fixture = ConvertFrom-Json $env:LISH_FIXTURE
$script:log = New-Object System.Collections.ArrayList
$script:failed = @{}
$script:dhcp = $fixture.dhcp
$script:nameServer = $fixture.nameServer
$script:dns = @()
$script:newState = $fixture.newAddressState

function ToSpan($value) { if ($null -eq $value) { [TimeSpan]::MaxValue } else { [TimeSpan]::Parse($value) } }
function Live($item, $store) { $item.Stores -contains $store }

function Note($name) {
	[void]$script:log.Add($name)
	$base = $name.Split(':')[0]
	if ($fixture.failOn -eq $base -and -not $script:failed[$base]) { $script:failed[$base] = $true; throw "injected failure in $base" }
}

$script:addresses = @()
foreach ($a in $fixture.addresses) { $script:addresses += [pscustomobject]@{ IPAddress = $a.IPAddress; PrefixLength = $a.PrefixLength; PrefixOrigin = $a.PrefixOrigin; SuffixOrigin = $a.SuffixOrigin; SkipAsSource = $a.SkipAsSource; ValidLifetime = (ToSpan $a.ValidLifetime); PreferredLifetime = (ToSpan $a.PreferredLifetime); Type = $a.Type; AddressState = 4; Stores = @($a.Stores) } }
$script:routes = @()
foreach ($r in $fixture.routes) { $script:routes += [pscustomobject]@{ NextHop = $r.NextHop; RouteMetric = $r.RouteMetric; Protocol = $r.Protocol; Publish = $r.Publish; ValidLifetime = (ToSpan $r.ValidLifetime); PreferredLifetime = (ToSpan $r.PreferredLifetime); Stores = @($r.Stores) } }

function Get-NetAdapter { [CmdletBinding()] param([switch]$IncludeHidden) [pscustomobject]@{ InterfaceGuid = $fixture.guid; ifIndex = 42 } }
function Get-NetIPInterface { [CmdletBinding()] param($InterfaceIndex, $AddressFamily) Note 'Get-NetIPInterface'; [pscustomobject]@{ Dhcp = $script:dhcp } }
function Get-ItemProperty { [CmdletBinding()] param($Path) Note 'Get-ItemProperty'; [pscustomobject]@{ NameServer = $script:nameServer } }
function Start-Sleep { [CmdletBinding()] param($Milliseconds) }

function Get-NetIPAddress {
	[CmdletBinding()] param($InterfaceIndex, $AddressFamily, $PolicyStore)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Get-NetIPAddress:$store"
	@($script:addresses | Where-Object { Live $_ $store })
}

function Get-NetRoute {
	[CmdletBinding()] param($InterfaceIndex, $DestinationPrefix, $PolicyStore)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Get-NetRoute:$store"
	@($script:routes | Where-Object { Live $_ $store })
}

function Remove-NetIPAddress {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $AddressFamily, $PolicyStore, $IPAddress)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Remove-NetIPAddress:$store"
	foreach ($a in $script:addresses) { $a.Stores = @($a.Stores | Where-Object { $_ -ne $store }) }
	$script:addresses = @($script:addresses | Where-Object { $_.Stores.Count -gt 0 })
}

function Remove-NetRoute {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $DestinationPrefix, $PolicyStore)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Remove-NetRoute:$store"
	foreach ($r in $script:routes) { $r.Stores = @($r.Stores | Where-Object { $_ -ne $store }) }
	$script:routes = @($script:routes | Where-Object { $_.Stores.Count -gt 0 })
}

function New-NetIPAddress {
	[CmdletBinding()] param($InterfaceIndex, $AddressFamily, $IPAddress, $PrefixLength, $DefaultGateway, $SkipAsSource, $ValidLifetime, $PreferredLifetime, $PolicyStore, $Type)
	$stores = if ($PolicyStore) { @($PolicyStore) } else { @('ActiveStore', 'PersistentStore') }
	Note "New-NetIPAddress:$($stores -join '+')"
	$state = if ($null -ne $script:newState) { $script:newState } else { 4 }
	$script:addresses += [pscustomobject]@{ IPAddress = $IPAddress; PrefixLength = [int]$PrefixLength; PrefixOrigin = 'Manual'; SuffixOrigin = 'Manual'; SkipAsSource = $SkipAsSource; ValidLifetime = (ToSpan $ValidLifetime); PreferredLifetime = (ToSpan $PreferredLifetime); Type = $Type; AddressState = $state; Stores = $stores }
	if ($DefaultGateway) { $script:routes += [pscustomobject]@{ NextHop = $DefaultGateway; RouteMetric = 256; Protocol = 'NetMgmt'; Publish = 'No'; ValidLifetime = [TimeSpan]::MaxValue; PreferredLifetime = [TimeSpan]::MaxValue; Stores = $stores } }
}

function New-NetRoute {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $DestinationPrefix, $NextHop, $RouteMetric, $Protocol, $Publish, $PolicyStore, $ValidLifetime, $PreferredLifetime)
	$stores = if ($PolicyStore) { @($PolicyStore) } else { @('ActiveStore', 'PersistentStore') }
	Note "New-NetRoute:$($stores -join '+')"
	$script:routes += [pscustomobject]@{ NextHop = $NextHop; RouteMetric = [int]$RouteMetric; Protocol = $Protocol; Publish = $Publish; ValidLifetime = (ToSpan $ValidLifetime); PreferredLifetime = (ToSpan $PreferredLifetime); Stores = $stores }
}

function Set-NetIPInterface { [CmdletBinding()] param($InterfaceIndex, $AddressFamily, $Dhcp) Note "Set-NetIPInterface:$Dhcp"; $script:dhcp = $Dhcp }

function Set-DnsClientServerAddress {
	[CmdletBinding()] param($InterfaceIndex, $ServerAddresses, [switch]$ResetServerAddresses)
	Note $(if ($ResetServerAddresses) { 'Set-DnsClientServerAddress:reset' } else { 'Set-DnsClientServerAddress:set' })
	$script:dns = if ($ResetServerAddresses) { @() } else { @($ServerAddresses) }
}
`;

/** Project the fake host's remaining state back out as JSON the test can read. */
const REPORT = String.raw`
$report = @{ calls = @($script:log); dhcp = $script:dhcp; dns = @($script:dns); error = $applyFailure
	addresses = @($script:addresses | ForEach-Object { @{ IPAddress = $_.IPAddress; PrefixLength = $_.PrefixLength; SkipAsSource = $_.SkipAsSource; Type = $_.Type; ValidLifetime = $_.ValidLifetime.ToString(); PreferredLifetime = $_.PreferredLifetime.ToString(); Stores = @($_.Stores) } })
	routes = @($script:routes | ForEach-Object { @{ NextHop = $_.NextHop; RouteMetric = $_.RouteMetric; Protocol = $_.Protocol; Publish = $_.Publish; ValidLifetime = $_.ValidLifetime.ToString(); PreferredLifetime = $_.PreferredLifetime.ToString(); Stores = @($_.Stores) } }) }
Write-Output ('LISHREPORT:' + (ConvertTo-Json $report -Depth 6 -Compress))
`;

/**
 * Run one generated apply script against a fake host and report what it did.
 *
 * The script is executed verbatim — no substitution, no reformatting — so what is
 * exercised is the same text `windowsApplyIPv4Command` hands to PowerShell. Only
 * the cmdlets underneath it are fakes.
 *
 * Windows only: the point is PowerShell's own parsing and control flow, which no
 * reimplementation would reproduce. Callers gate on `process.platform`.
 */
export async function runWindowsApplyScript(command: string, host: FakeHost): Promise<HarnessResult> {
	const script = `${STUBS}\n$applyFailure = $null\ntry { ${command} } catch { $applyFailure = $_.Exception.Message }\n${REPORT}`;
	const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, LISH_FIXTURE: JSON.stringify(host) }, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
	const marker = stdout.indexOf('LISHREPORT:');
	if (marker === -1) throw new Error(`the harness produced no report: ${stdout}`);
	return JSON.parse(stdout.slice(marker + 'LISHREPORT:'.length)) as HarnessResult;
}

/** A single-address static interface with one default route, held in both stores. */
export function staticHost(guid: string, overrides: Partial<FakeHost> = {}): FakeHost {
	return { guid, dhcp: 'Disabled', addresses: [{ IPAddress: '192.0.2.10', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast', Stores: ['ActiveStore', 'PersistentStore'] }], routes: [{ NextHop: '192.0.2.1', RouteMetric: 25, Protocol: 'NetMgmt', Publish: 'No', ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Stores: ['ActiveStore', 'PersistentStore'] }], nameServer: '198.51.100.1', ...overrides };
}
