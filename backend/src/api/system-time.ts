import type { SystemTimeResult, SystemTimeStatus } from '@shared';
import type { initSystemHandlers } from './system.ts';

interface TimeClient {
	data: { isLocalClient: boolean };
}

type TimeSystem = Pick<ReturnType<typeof initSystemHandlers>, 'getTime' | 'listTimezones' | 'setClock' | 'setTimezone' | 'setNtpServer' | 'setNtpEnabled' | 'applyTimeSettings'>;
type TimeHandler = (params: any, client: TimeClient) => any;

/** Keep the host state readable while advertising only actions this client may perform. */
export function timeStatusForClient(status: SystemTimeStatus, authenticated: boolean, local: boolean): SystemTimeStatus {
	if (authenticated && local) return status;
	return { ...status, capabilities: { setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false } };
}

/** Bind every host-time write to authenticated clients on this machine. */
export function createTimeApiHandlers(system: TimeSystem, authenticated: boolean): Record<string, TimeHandler> {
	const protect = <P>(write: (params: P) => Promise<SystemTimeResult>) => async (params: P, client: TimeClient): Promise<SystemTimeResult> => {
		if (!authenticated || !client.data.isLocalClient) {
			return { success: false, outcome: 'permission-denied', message: 'Changing system time requires an authenticated client on this machine' };
		}
		return write(params);
	};
	return {
		'system.getTime': async (_params, client) => timeStatusForClient(await system.getTime(), authenticated, client.data.isLocalClient),
		'system.listTimezones': system.listTimezones,
		'system.setClock': protect(system.setClock),
		'system.setTimezone': protect(system.setTimezone),
		'system.setNtpServer': protect(system.setNtpServer),
		'system.setNtpEnabled': protect(system.setNtpEnabled),
		'system.applyTimeSettings': protect(system.applyTimeSettings),
	};
}
