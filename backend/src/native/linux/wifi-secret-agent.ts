import { randomUUID } from 'node:crypto';
import { variant, type DBusMethodCall, type DBusMethodResponse, type DBusReply, type DBusSubscription, type SystemBus } from './dbus.ts';
import { wifiDictionary, wifiString, wifiValue, type WifiProperties } from './wifi-settings.ts';

const AGENT = 'org.freedesktop.NetworkManager.SecretAgent';
const AGENT_PATH = '/org/freedesktop/NetworkManager/SecretAgent';
const MANAGER = 'org.freedesktop.NetworkManager.AgentManager';
const MANAGER_PATH = '/org/freedesktop/NetworkManager/AgentManager';
const SETTING = '802-11-wireless-security';

export interface WifiSecretScope {
	readonly profilePath: string;
	readonly uuid: string;
	readonly ssidHex: string;
	readonly authentication: 'wpa-psk' | 'sae';
	readonly password: string;
}

type AgentBus = Pick<SystemBus, 'call' | 'exportObject'>;

function noSecrets(): DBusMethodResponse {
	return { errorName: `${AGENT}.NoSecrets`, errorMessage: 'No credentials for this request' };
}

/** One interactive password, restricted to the recorded NM owner and selected profile. */
export class WifiSecretAgent {
	private readonly bus: AgentBus;
	private readonly owner: string;
	private readonly scope: Omit<WifiSecretScope, 'password'>;
	private readonly password: Buffer;
	private readonly object: DBusSubscription;
	private supplied = false;
	private closed = false;

	constructor(bus: AgentBus, owner: string, scope: WifiSecretScope) {
		this.bus = bus;
		this.owner = owner;
		this.scope = { profilePath: scope.profilePath, uuid: scope.uuid, ssidHex: scope.ssidHex, authentication: scope.authentication };
		this.password = Buffer.from(scope.password, 'utf8');
		this.object = bus.exportObject(
			AGENT_PATH,
			owner,
			call => this.respond(call),
			() => {
				this.closed = true;
				this.password.fill(0);
			}
		);
	}

	register(): Promise<DBusReply> {
		return this.bus.call({ kind: 'mutation', destination: this.owner, path: MANAGER_PATH, interface: MANAGER, member: 'RegisterWithCapabilities', signature: 'su', args: [`org.libershare.Wifi.${randomUUID()}`, 0] });
	}

	unregister(): Promise<DBusReply> {
		return this.bus.call({ kind: 'mutation', destination: this.owner, path: MANAGER_PATH, interface: MANAGER, member: 'Unregister' });
	}

	close(): void {
		this.object.close();
	}

	private matchesProfile(call: DBusMethodCall): boolean {
		if (call.values[1] !== this.scope.profilePath) return false;
		try {
			const settings = wifiDictionary(call.values[0]);
			const connection = wifiDictionary(settings['connection']) as WifiProperties;
			const wireless = wifiDictionary(settings['802-11-wireless']) as WifiProperties;
			const security = wifiDictionary(settings[SETTING]) as WifiProperties;
			const ssid = wifiValue(wireless, 'ssid', 'ay');
			return wifiString(connection, 'uuid') === this.scope.uuid && wifiString(connection, 'type') === '802-11-wireless' && ssid instanceof Uint8Array && Buffer.from(ssid).toString('hex') === this.scope.ssidHex && wifiString(security, 'key-mgmt') === this.scope.authentication;
		} catch {
			return false;
		}
	}

	private respond(call: DBusMethodCall): DBusMethodResponse {
		if (this.closed || call.sender !== this.owner || call.interface !== AGENT) return noSecrets();
		if (call.member === 'CancelGetSecrets') {
			return call.signature === 'os' && call.values[0] === this.scope.profilePath && call.values[1] === SETTING ? { signature: '', args: [] } : noSecrets();
		}
		if (!this.matchesProfile(call)) return noSecrets();
		if (call.member === 'SaveSecrets' || call.member === 'DeleteSecrets') return call.signature === 'a{sa{sv}}o' ? { signature: '', args: [] } : noSecrets();
		if (call.member !== 'GetSecrets' || call.signature !== 'a{sa{sv}}osasu' || call.values[2] !== SETTING || typeof call.values[4] !== 'number') return noSecrets();
		const flags = call.values[4];
		// Match nmcli: stored-secret lookups do not consume the interactive answer.
		if (!(flags & 1)) return noSecrets();
		if (this.supplied && flags & 2) return { errorName: `${AGENT}.UserCanceled`, errorMessage: 'No further interactive password is available' };
		this.supplied = true;
		return { signature: 'a{sa{sv}}', args: [{ [SETTING]: { psk: variant('s', this.password.toString('utf8')) } }] };
	}
}
