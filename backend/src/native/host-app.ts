/** Work the desktop app process does for the backend, available only while the backend runs under it. */
export type HostAppCall = (request: string) => Promise<string>;

let host: HostAppCall | null = null;

/** Set by the owner of the desktop IPC transport. */
export function setHostApp(call: HostAppCall | null): void {
	host = call;
}

export function hostApp(): HostAppCall | null {
	return host;
}
