// The IPC process must never construct an administrative HTTP/WebSocket listener.
Bun.serve = (() => {
	throw new Error('HTTP listener attempted in IPC mode');
}) as typeof Bun.serve;
