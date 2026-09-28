/*
 * A simple API client that communicates with a server over WebSocket.
 * we should partly unify this with the
 */

interface Request {
	id: string;
	method: string;
	params?: Record<string, any> | undefined;
}

/**
 * The URL to connect to: a token given in `--url` wins, otherwise `LISH_TOKEN` is added as the
 * single `token` parameter. Two tokens in the URL are refused rather than guessed between.
 */
export function withToken(url: string, envToken: string | undefined): string {
	const parsed = new URL(url);
	const given = parsed.searchParams.getAll('token');
	if (given.length > 1) throw new Error('the URL carries more than one token');
	// A WebSocket URL cannot carry one, and the error that says so would print the token.
	if (parsed.hash) throw new Error('the URL must not have a fragment');
	if (given.length === 0 && envToken) parsed.searchParams.set('token', envToken);
	return parsed.toString();
}

/**
 * A message fit for the terminal: every token the CLI knows of — from the environment or the
 * URL, raw or percent-encoded — and any `token=` query value replaced by `***`. Error messages
 * from URL parsing and from the WebSocket quote the URL they were given.
 */
export function redactTokens(message: string, url: string, envToken: string | undefined): string {
	const secrets = new Set<string>();
	if (envToken) secrets.add(envToken);
	try {
		for (const token of new URL(url).searchParams.getAll('token')) if (token) secrets.add(token);
	} catch {}
	let out = message.replace(/([?&]token=)[^&#\s"']*/gi, '$1***');
	// A bare token shorter than four characters would blank out ordinary words of the message;
	// such a token is still caught by the `token=` rule above.
	for (const secret of secrets) if (secret.length >= 4) for (const form of [secret, encodeURIComponent(secret)]) out = out.split(form).join('***');
	return out;
}

/** The URL as shown to the user: no query (it holds the token) and no credentials. */
export function displayURL(url: string): string {
	const parsed = new URL(url);
	parsed.search = '';
	parsed.username = '';
	parsed.password = '';
	return parsed.toString();
}

export class APIClient {
	private readonly url: string;
	private readonly envToken = process.env['LISH_TOKEN'];
	private ws: WebSocket | null = null;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private eventHandlers = new Map<string, ((data: any) => void)[]>();

	constructor(url: string) {
		try {
			this.url = withToken(url, this.envToken);
		} catch (error) {
			throw new Error('Invalid --url: ' + redactTokens(String(error instanceof Error ? error.message : error), url, this.envToken));
		}
	}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.url);
			} catch (error) {
				reject(this.error(String(error instanceof Error ? error.message : error)));
				return;
			}

			this.ws.onopen = () => resolve();
			this.ws.onerror = err => reject(this.error(`WebSocket error: ${err}`));

			this.ws.onmessage = event => {
				const msg = JSON.parse(event.data as string);

				if (msg.id !== undefined) {
					// Response to a request
					const pending = this.pending.get(msg.id);
					if (pending) {
						this.pending.delete(msg.id);
						if (msg.error) pending.reject(this.error(String(msg.error)));
						else pending.resolve(msg.result);
					}
				} else if (msg.event) {
					// Event notification
					const handlers = this.eventHandlers.get(msg.event) || [];
					handlers.forEach(h => h(msg.data));
				}
			};

			this.ws.onclose = () => {
				// Reject all pending requests
				for (const [, pending] of this.pending) pending.reject(new Error('Connection closed'));
				this.pending.clear();
			};
		});
	}

	private error(message: string): Error {
		return new Error(redactTokens(message, this.url, this.envToken));
	}

	async call<T = any>(method: string, params?: Record<string, any>): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
		const id = crypto.randomUUID();
		const request: Request = { id, method, params };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(JSON.stringify(request));
		});
	}

	on(event: string, handler: (data: any) => void): void {
		const handlers = this.eventHandlers.get(event) || [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	off(event: string, handler: (data: any) => void): void {
		const handlers = this.eventHandlers.get(event) || [];
		const index = handlers.indexOf(handler);
		if (index !== -1) handlers.splice(index, 1);
	}

	close(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}
