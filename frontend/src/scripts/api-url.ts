import { DEFAULT_API_URL } from '@shared';

type ApiWindow = {
	location: {
		protocol: string;
		host: string;
		search: string;
	};
	__BACKEND_PORT__?: number | string;
};

type ApiUrlOptions = {
	window?: ApiWindow | undefined;
	viteBackendUrl?: string | undefined;
	dev?: boolean | undefined;
};

function viteBackendUrl(): string | undefined {
	return (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_BACKEND_URL'];
}

function viteDev(): boolean {
	return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
}

export function getAPIURL(options: ApiUrlOptions = {}): string {
	const browserWindow = options.window ?? (typeof window !== 'undefined' ? (window as unknown as ApiWindow) : undefined);
	const configuredBackendUrl = options.viteBackendUrl ?? viteBackendUrl();
	const isDev = options.dev ?? viteDev();

	if (browserWindow) {
		// URL param override for multi-node dev testing (e.g. ?backend=ws://localhost:1159)
		if (isDev) {
			const param = new URLSearchParams(browserWindow.location.search).get('backend');
			if (param) return param;
		}
		// When running inside Tauri, the backend port is passed via initialization script.
		if (browserWindow.__BACKEND_PORT__) return `ws://localhost:${browserWindow.__BACKEND_PORT__}`;
		if (!configuredBackendUrl) {
			const protocol = browserWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
			return `${protocol}//${browserWindow.location.host}/ws`;
		}
	}

	return configuredBackendUrl || DEFAULT_API_URL;
}
