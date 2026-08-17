import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** One of the two policy stores an object can live in. */
export type PolicyStore = 'ActiveStore' | 'PersistentStore';

/**
 * One IPv4 address as ONE policy store holds it.
 *
 * Per store, not per address, and that is the whole point. The first version of
 * this carried one property set plus a `Stores` array, which cannot express the
 * state the two stores are actually free to be in: `Set-NetIPAddress` and
 * `Set-NetRoute` can be pointed at the active store alone, so the same address or
 * the same next hop legitimately exists in both stores with DIFFERENT properties —
 * an active route at metric 5 against a persistent one at metric 100. A model that
 * cannot represent that cannot catch a rollback which restores both from the active
 * copy and silently rewrites the startup configuration. An object in both stores is
 * two rows here, exactly as it is two objects on the machine.
 */
export interface FakeAddress {
	Store: PolicyStore;
	IPAddress: string;
	PrefixLength: number;
	PrefixOrigin?: string;
	SuffixOrigin?: string;
	SkipAsSource?: boolean;
	ValidLifetime?: string;
	PreferredLifetime?: string;
	Type?: string;
}

/** One IPv4 default route as ONE policy store holds it — see {@link FakeAddress}. */
export interface FakeRoute {
	Store: PolicyStore;
	NextHop: string;
	RouteMetric: number;
	Protocol?: string;
	Publish?: string;
	ValidLifetime?: string;
	PreferredLifetime?: string;
}

/** The rows one policy store holds, in the order the fake host kept them. */
export function inStore<T extends { Store: PolicyStore }>(rows: readonly T[], store: PolicyStore): T[] {
	return rows.filter(row => row.Store === store);
}

/** The same object in both stores, from one property set — the ordinary case. */
export function inBothStores<T extends { Store: PolicyStore }>(row: Omit<T, 'Store'>): T[] {
	return [{ ...row, Store: 'ActiveStore' } as T, { ...row, Store: 'PersistentStore' } as T];
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
	/**
	 * How many identity-scoped removals report success without removing anything.
	 *
	 * The failure mode the postcondition check exists for, and one no `-ErrorAction`
	 * can see: `Remove-NetIPAddress`/`Remove-NetRoute` returns cleanly and the object
	 * is still in the active store. Only the removals that name an address or a next
	 * hop are affected — those are the ones that follow a create-both, which is the
	 * pair that is not atomic. The bulk removals at the head of the apply take a
	 * whole interface at once and are left alone, so a fixture can provoke this
	 * without changing what the apply had to undo.
	 */
	removalsIgnored?: number;
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

# The stores a write with no -PolicyStore lands in. All four writing cmdlets agree:
# omitting the parameter writes both, and naming ActiveStore is the only supported
# way to write one.
function TargetStores($store) { if ($store) { @($store) } else { @('ActiveStore', 'PersistentStore') } }

# A removal that matched nothing, in the one category the apply is allowed to
# ignore. The real cmdlets raise ObjectNotFound for it and anything else for a
# genuine failure, and the whole of the apply's missing-object tolerance turns on
# that distinction — stubs that never threw at all left it untested.
function NotFound($message) { New-Object System.Management.Automation.ErrorRecord ([Exception]::new($message)), 'NotFound', ([System.Management.Automation.ErrorCategory]::ObjectNotFound), $null }

# A removal that reports success and removes nothing — see FakeHost.removalsIgnored.
$script:removalsIgnored = [int]$fixture.removalsIgnored
function IgnoreThisRemoval($identity) {
	if ($null -eq $identity -or $script:removalsIgnored -le 0) { return $false }
	$script:removalsIgnored -= 1
	$true
}

function Note($name) {
	[void]$script:log.Add($name)
	$base = $name.Split(':')[0]
	if ($fixture.failOn -eq $base -and -not $script:failed[$base]) { $script:failed[$base] = $true; throw "injected failure in $base" }
}

# Neither creating cmdlet can write the persistent store on its own. New-NetIPAddress
# is documented "Specify ActiveStore only", and New-NetRoute's own PolicyStore entry
# says of PersistentStore, in as many words, "Cannot be used" — the parameter exists
# to create an object in JUST the active store, and omitting it is the only way to
# reach the persistent one. Accepting the value here, as these stubs first did, is
# what let a rollback that emits it pass: the fake wrote the object where the real
# provider would have refused, so the generated script was never held to the contract
# it will meet on a real adapter.
function RejectPersistentCreate($cmdlet, $store) {
	if ($store -eq 'PersistentStore') { throw "$cmdlet cannot create an object with -PolicyStore PersistentStore" }
}

$script:addresses = @()
foreach ($a in $fixture.addresses) { $script:addresses += [pscustomobject]@{ Store = $a.Store; IPAddress = $a.IPAddress; PrefixLength = $a.PrefixLength; PrefixOrigin = $a.PrefixOrigin; SuffixOrigin = $a.SuffixOrigin; SkipAsSource = $a.SkipAsSource; ValidLifetime = (ToSpan $a.ValidLifetime); PreferredLifetime = (ToSpan $a.PreferredLifetime); Type = $a.Type; AddressState = 4 } }
$script:routes = @()
foreach ($r in $fixture.routes) { $script:routes += [pscustomobject]@{ Store = $r.Store; NextHop = $r.NextHop; RouteMetric = $r.RouteMetric; Protocol = $r.Protocol; Publish = $r.Publish; ValidLifetime = (ToSpan $r.ValidLifetime); PreferredLifetime = (ToSpan $r.PreferredLifetime) } }

function Get-NetAdapter { [CmdletBinding()] param([switch]$IncludeHidden) [pscustomobject]@{ InterfaceGuid = $fixture.guid; ifIndex = 42 } }
function Get-NetIPInterface { [CmdletBinding()] param($InterfaceIndex, $AddressFamily) Note 'Get-NetIPInterface'; [pscustomobject]@{ Dhcp = $script:dhcp } }
function Get-ItemProperty { [CmdletBinding()] param($Path) Note 'Get-ItemProperty'; [pscustomobject]@{ NameServer = $script:nameServer } }
function Start-Sleep { [CmdletBinding()] param($Milliseconds) }

function Get-NetIPAddress {
	[CmdletBinding()] param($InterfaceIndex, $AddressFamily, $PolicyStore)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Get-NetIPAddress:$store"
	@($script:addresses | Where-Object { $_.Store -eq $store })
}

function Get-NetRoute {
	[CmdletBinding()] param($InterfaceIndex, $DestinationPrefix, $PolicyStore)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Get-NetRoute:$store"
	@($script:routes | Where-Object { $_.Store -eq $store })
}

function Remove-NetIPAddress {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $AddressFamily, $PolicyStore, $IPAddress)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Remove-NetIPAddress:$store"
	if (IgnoreThisRemoval $IPAddress) { return }
	$hit = @($script:addresses | Where-Object { $_.Store -eq $store -and ($null -eq $IPAddress -or $_.IPAddress -eq $IPAddress) })
	if ($hit.Count -eq 0) { throw (NotFound 'no matching MSFT_NetIPAddress objects found') }
	$script:addresses = @($script:addresses | Where-Object { $hit -notcontains $_ })
}

function Remove-NetRoute {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $DestinationPrefix, $PolicyStore, $NextHop)
	$store = if ($PolicyStore) { $PolicyStore } else { 'ActiveStore' }
	Note "Remove-NetRoute:$store"
	if (IgnoreThisRemoval $NextHop) { return }
	$hit = @($script:routes | Where-Object { $_.Store -eq $store -and ($null -eq $NextHop -or $_.NextHop -eq $NextHop) })
	if ($hit.Count -eq 0) { throw (NotFound 'no matching MSFT_NetRoute objects found') }
	$script:routes = @($script:routes | Where-Object { $hit -notcontains $_ })
}

function New-NetIPAddress {
	[CmdletBinding()] param($InterfaceIndex, $AddressFamily, $IPAddress, $PrefixLength, $DefaultGateway, $SkipAsSource, $ValidLifetime, $PreferredLifetime, $PolicyStore, $Type)
	$stores = TargetStores $PolicyStore
	Note "New-NetIPAddress:$($stores -join '+')"
	RejectPersistentCreate 'New-NetIPAddress' $PolicyStore
	$state = if ($null -ne $script:newState) { $script:newState } else { 4 }
	# One row per store, and separate objects: a write to both stores makes two
	# objects the machine can afterwards change one of.
	foreach ($s in $stores) {
		$script:addresses += [pscustomobject]@{ Store = $s; IPAddress = $IPAddress; PrefixLength = [int]$PrefixLength; PrefixOrigin = 'Manual'; SuffixOrigin = 'Manual'; SkipAsSource = $SkipAsSource; ValidLifetime = (ToSpan $ValidLifetime); PreferredLifetime = (ToSpan $PreferredLifetime); Type = $Type; AddressState = $state }
		if ($DefaultGateway) { $script:routes += [pscustomobject]@{ Store = $s; NextHop = $DefaultGateway; RouteMetric = 256; Protocol = 'NetMgmt'; Publish = 'No'; ValidLifetime = [TimeSpan]::MaxValue; PreferredLifetime = [TimeSpan]::MaxValue } }
	}
}

function New-NetRoute {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $DestinationPrefix, $NextHop, $RouteMetric, $Protocol, $Publish, $PolicyStore, $ValidLifetime, $PreferredLifetime)
	$stores = TargetStores $PolicyStore
	Note "New-NetRoute:$($stores -join '+')"
	RejectPersistentCreate 'New-NetRoute' $PolicyStore
	foreach ($s in $stores) { $script:routes += [pscustomobject]@{ Store = $s; NextHop = $NextHop; RouteMetric = [int]$RouteMetric; Protocol = $Protocol; Publish = $Publish; ValidLifetime = (ToSpan $ValidLifetime); PreferredLifetime = (ToSpan $PreferredLifetime) } }
}

# Documented "Specify ActiveStore only", and without the parameter it changes the
# object in both stores — which is what makes an active-only Set the way the two
# stores come to disagree in the first place.
function Set-NetRoute {
	[CmdletBinding(SupportsShouldProcess = $true)] param($InterfaceIndex, $DestinationPrefix, $NextHop, $RouteMetric, $Publish, $ValidLifetime, $PreferredLifetime, $PolicyStore)
	Note 'Set-NetRoute'
	$stores = TargetStores $PolicyStore
	# Exactly the four the real cmdlet can change. NextHop and Protocol appear only as
	# array-typed query parameters, and Windows refuses to modify either after the
	# route exists.
	foreach ($r in $script:routes) {
		if ($r.NextHop -ne $NextHop -or $stores -notcontains $r.Store) { continue }
		if ($null -ne $RouteMetric) { $r.RouteMetric = [int]$RouteMetric }
		if ($null -ne $Publish) { $r.Publish = $Publish }
		if ($null -ne $ValidLifetime) { $r.ValidLifetime = (ToSpan $ValidLifetime) }
		if ($null -ne $PreferredLifetime) { $r.PreferredLifetime = (ToSpan $PreferredLifetime) }
	}
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
	addresses = @($script:addresses | ForEach-Object { @{ Store = $_.Store; IPAddress = $_.IPAddress; PrefixLength = $_.PrefixLength; SkipAsSource = $_.SkipAsSource; Type = $_.Type; ValidLifetime = $_.ValidLifetime.ToString(); PreferredLifetime = $_.PreferredLifetime.ToString() } })
	routes = @($script:routes | ForEach-Object { @{ Store = $_.Store; NextHop = $_.NextHop; RouteMetric = $_.RouteMetric; Protocol = $_.Protocol; Publish = $_.Publish; ValidLifetime = $_.ValidLifetime.ToString(); PreferredLifetime = $_.PreferredLifetime.ToString() } }) }
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
	return { guid, dhcp: 'Disabled', addresses: inBothStores<FakeAddress>({ IPAddress: '192.0.2.10', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast' }), routes: inBothStores<FakeRoute>({ NextHop: '192.0.2.1', RouteMetric: 25, Protocol: 'NetMgmt', Publish: 'No', ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME }), nameServer: '198.51.100.1', ...overrides };
}
