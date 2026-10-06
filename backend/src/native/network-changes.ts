import { createHash, randomBytes } from 'node:crypto';
import { CodedError, ErrorCodes, ipv4BaselineOf, sameIPv4Baseline, validateIPv4Config, type NetIPv4Config, type NetworkStateInfo } from '@shared';
import { NativeMutationHost, type NativeMutationOptions, type NativeMutationState, type NativeSettlement } from './mutation-host.ts';
import { NativeMutationBusy, type JournalValue, type NativeMutationRecord } from './mutation-journal.ts';
import { withNativeMutationContext } from './mutation-context.ts';
import { assertAppliedIPv4State, assertIPv4Baseline, leaseRequired, planIPv4Change } from '../system-network.ts';
import { NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS, NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS, NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS, NETWORK_MANAGER_CHECKPOINT_SAFETY_MS } from '../system-network-linux.ts';
import { observeNativeLinuxIPv4Profile } from './linux/network-mutation.ts';
import { isWifiRecoveryData, observeNativeLinuxWifi } from './linux/wifi-recovery.ts';
import { isWindowsIPv4Recovery, observeNativeWindowsIPv4 } from './win32/network-mutation.ts';
import { isDarwinIPv4Recovery, observeNativeDarwinIPv4 } from './darwin/network-mutation.ts';

interface WifiRequest {
	operation: 'connect' | 'disconnect';
	interfaceID: string;
	ssid?: string;
	bssid?: string | null;
	password?: string;
	expectedSecurity?: string;
	expectedSsidHex?: string;
}

interface IPv4Recovery {
	kind: 'ipv4';
	interfaceID: string;
	original: ReturnType<typeof ipv4BaselineOf>;
	desired: NetIPv4Config;
	requireLease: boolean;
	addressingChanged: boolean;
	profilePath?: string;
	profileUuid?: string;
	originalProfileFingerprint?: string;
}

export class NativeNetworkChanges {
	private readonly host: NativeMutationHost;
	private readonly read: () => Promise<NetworkStateInfo>;
	private recovery: Promise<void> | null = null;
	private stopping = false;

	constructor(host: NativeMutationHost, read: () => Promise<NetworkStateInfo>) {
		this.host = host;
		this.read = read;
	}

	async assertIdle(): Promise<void> {
		if (await this.host.state('network')) throw new CodedError(ErrorCodes.NETCONFIG_BUSY);
	}

	async state(): Promise<NativeMutationState | undefined> {
		return this.host.state('network');
	}

	async acknowledge(): Promise<void> {
		try {
			await this.host.acknowledge('network');
		} catch (error) {
			if (error instanceof NativeMutationBusy || (error instanceof Error && error.name === 'NativeMutationBusy')) throw new CodedError(ErrorCodes.NETCONFIG_BUSY);
			throw error;
		}
	}

	startRecovery(): void {
		if (this.stopping || this.recovery) return;
		this.recovery = this.host
			.recover(
				'network',
				record => this.host.observe(record),
				record => this.verify(record, true)
			)
			.catch(error => {
				console.warn('[system-network] Cannot verify interrupted native change:', error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				this.recovery = null;
			});
	}

	async close(): Promise<void> {
		this.stopping = true;
		await this.recovery;
	}

	async applyIPv4(interfaceID: string, desired: NetIPv4Config, expected: unknown, action: () => Promise<NetworkStateInfo>): Promise<NetworkStateInfo> {
		const invalid = validateIPv4Config(desired);
		if (invalid || typeof interfaceID !== 'string' || !interfaceID) throw new CodedError(ErrorCodes.NETCONFIG_INVALID);
		await this.assertIdle();
		const before = await this.read();
		if (before.stale || !before.known || before.detail !== 'full') throw new CodedError(ErrorCodes.NETCONFIG_STALE);
		const target = before.interfaces.find(item => item.id === interfaceID);
		if (!target) throw new CodedError(ErrorCodes.NETCONFIG_INVALID);
		if (!target.ipv4Configurable || target.ipv4Mode === 'unknown') throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED);
		assertIPv4Baseline(target, expected);
		const saved: NetIPv4Config = { mode: desired.mode, ...(desired.address !== undefined ? { address: desired.address } : {}), ...(desired.prefixLength !== undefined ? { prefixLength: desired.prefixLength } : {}), ...(desired.gateway !== undefined ? { gateway: desired.gateway } : {}), ...(desired.dns !== undefined ? { dns: [...desired.dns] } : {}) };
		const data: IPv4Recovery = { kind: 'ipv4', interfaceID, original: ipv4BaselineOf(target), desired: saved, requireLease: leaseRequired(target), addressingChanged: planIPv4Change(target, desired).addressingChanged };
		const serialized = JSON.stringify(data);
		return this.run({ domain: 'network', operation: 'applyIPv4', requestHash: createHash('sha256').update(serialized).digest('hex'), recoveryData: JSON.parse(serialized) as JournalValue, timeoutMs: NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS + NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS + NETWORK_MANAGER_CHECKPOINT_SAFETY_MS }, action);
	}

	async wifi(request: WifiRequest, action: () => Promise<NetworkStateInfo>): Promise<NetworkStateInfo> {
		await this.assertIdle();
		const recoveryData = { kind: 'wifi', interfaceID: request.interfaceID, operation: request.operation };
		// The password identifies this in-memory request but never enters the journal.
		const requestHash = createHash('sha256').update(randomBytes(32)).update(JSON.stringify(request)).digest('hex');
		return this.run({ domain: 'network', operation: request.operation === 'connect' ? 'connectWifi' : 'disconnectWifi', requestHash, recoveryData, timeoutMs: NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS + NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS + NETWORK_MANAGER_CHECKPOINT_SAFETY_MS }, action);
	}

	private async run(options: NativeMutationOptions, action: () => Promise<NetworkStateInfo>): Promise<NetworkStateInfo> {
		try {
			const result = await this.host.run(
				options,
				context => withNativeMutationContext(context, action),
				record => this.verify(record)
			);
			const mutation = await this.state();
			const current = result.state === 'completed' ? result.value : await this.read();
			return mutation ? { ...current, mutation } : current;
		} catch (error) {
			if (error instanceof NativeMutationBusy || (error instanceof Error && error.name === 'NativeMutationBusy')) throw new CodedError(ErrorCodes.NETCONFIG_BUSY);
			throw error;
		}
	}

	private async verify(record: NativeMutationRecord, recovering = false): Promise<NativeSettlement> {
		const recovery = record.recoveryData;
		if (recovery && typeof recovery === 'object' && !Array.isArray(recovery) && recovery['kind'] === 'wifi') {
			if (recovery['wifi'] === undefined) return recovering ? 'interrupted' : 'completed';
			if (!isWifiRecoveryData(recovery['wifi'])) return 'interrupted';
			const observed = await observeNativeLinuxWifi(recovery['wifi'], 15000);
			if (observed.outcome === 'password-committed') return { state: 'interrupted', operation: 'wifiPasswordChanged' };
			return observed.outcome === 'original' || observed.outcome === 'target' ? 'completed' : 'interrupted';
		}
		const data = record.recoveryData as unknown as IPv4Recovery;
		if (!data || data.kind !== 'ipv4' || typeof data.interfaceID !== 'string' || !data.original || validateIPv4Config(data.desired) || typeof data.requireLease !== 'boolean' || typeof data.addressingChanged !== 'boolean') return 'interrupted';
		if (recovery && typeof recovery === 'object' && !Array.isArray(recovery) && recovery['windowsIPv4'] !== undefined) {
			if (!isWindowsIPv4Recovery(recovery['windowsIPv4'])) return 'interrupted';
			const observed = await observeNativeWindowsIPv4(recovery['windowsIPv4'], 15000);
			return observed.original || observed.target ? 'completed' : 'interrupted';
		}
		if (recovery && typeof recovery === 'object' && !Array.isArray(recovery) && recovery['darwinIPv4'] !== undefined) {
			if (!isDarwinIPv4Recovery(recovery['darwinIPv4'])) return 'interrupted';
			const observed = await observeNativeDarwinIPv4(recovery['darwinIPv4'], 15000);
			return observed.original || observed.target ? 'completed' : 'interrupted';
		}
		if (recovering && data.originalProfileFingerprint === undefined) return 'interrupted';
		const state = await this.read();
		if (!state.known || state.detail !== 'full' || state.stale) throw new Error('Network state is unavailable for recovery');
		const target = state.interfaces.find(item => item.id === data.interfaceID);
		if (!target) return 'interrupted';
		let originalProfile = true;
		let desiredProfile = true;
		if (data.originalProfileFingerprint !== undefined) {
			if (typeof data.originalProfileFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(data.originalProfileFingerprint) || typeof data.profilePath !== 'string' || typeof data.profileUuid !== 'string') return 'interrupted';
			const observed = await observeNativeLinuxIPv4Profile(data.interfaceID, data.desired, { profilePath: data.profilePath, profileUuid: data.profileUuid, addressingChanged: data.addressingChanged, requireLease: data.requireLease, timeoutMs: 15000 });
			if (!observed.exists || !observed.appliesToDevice) return 'interrupted';
			originalProfile = observed.fingerprint === data.originalProfileFingerprint;
			desiredProfile = observed.matchesDesired;
		}
		if (originalProfile && target.ipv4Configurable && sameIPv4Baseline(ipv4BaselineOf(target), data.original)) return 'completed';
		if (!desiredProfile) return 'interrupted';
		try {
			assertAppliedIPv4State(state, data.interfaceID, data.desired, data.addressingChanged, data.requireLease);
			return 'completed';
		} catch {
			return 'interrupted';
		}
	}
}
