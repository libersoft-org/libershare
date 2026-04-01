type BroadcastFn = (event: string, data: any) => void;

const CHECK_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FAIL_THRESHOLD = 2; // consecutive failures before reporting offline

interface ConnectivityTarget {
	url: string;
	validate: (response: Response) => Promise<boolean>;
}

const TARGETS: ConnectivityTarget[] = [
	{
		url: 'http://connectivitycheck.gstatic.com/generate_204',
		validate: async (r) => r.status === 204,
	},
	{
		url: 'http://www.msftconnecttest.com/connecttest.txt',
		validate: async (r) => r.ok && (await r.text()).includes('Microsoft Connect Test'),
	},
];

async function checkOnline(): Promise<boolean> {
	for (const target of TARGETS) {
		try {
			const response = await fetch(target.url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				redirect: 'error',
			});
			if (await target.validate(response)) return true;
		} catch {
			// try next target
		}
	}
	return false;
}

export function startConnectivityCheck(broadcast: BroadcastFn): () => void {
	let online = true; // assume online at start
	let consecutiveFailures = 0;
	let running = false;
	let interval: ReturnType<typeof setInterval> | undefined;
	let initialTimeout: ReturnType<typeof setTimeout> | undefined;

	const check = async () => {
		if (running) return;
		running = true;
		try {
			const result = await checkOnline();
			if (result) {
				consecutiveFailures = 0;
				if (!online) {
					online = true;
					console.log('[Connectivity] Internet connection restored');
					broadcast('internet:status', { online: true });
				}
			} else {
				consecutiveFailures++;
				if (online && consecutiveFailures >= FAIL_THRESHOLD) {
					online = false;
					console.log('[Connectivity] Internet connection lost');
					broadcast('internet:status', { online: false });
				}
			}
		} finally {
			running = false;
		}
	};

	// Initial check after short delay (let network settle on startup)
	initialTimeout = setTimeout(check, 5_000);
	interval = setInterval(check, CHECK_INTERVAL_MS);

	return () => {
		if (initialTimeout) clearTimeout(initialTimeout);
		if (interval) clearInterval(interval);
	};
}
