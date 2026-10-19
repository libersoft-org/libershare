import net from 'node:net';
import { type OverlayInviteAnswer, type OverlayInviteMessage } from '@shared';
import { OVERLAY_LIBP2P_PORT } from './nebula-config.ts';

/**
 * The invite exchange: one JSON line from the invited node (its request, {@link OverlayInviteMessage}), one JSON line
 * back ({@link OverlayInviteAnswer}), over TCP inside the overlay from the guest's helper to the founder's node.
 */

const MAX_LINE_BYTES = 64 * 1024;
const EXCHANGE_TIMEOUT_MS = 30_000;

/** One `\n`-terminated JSON line, within the size and time limits; null when the far end closed without one. */
export function readJSONLine(socket: net.Socket, timeoutMs: number = EXCHANGE_TIMEOUT_MS): Promise<any> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const done = (err: Error | null, value?: any): void => {
			clearTimeout(timer);
			socket.off('data', onData);
			socket.off('end', onEnd);
			socket.off('error', onError);
			if (err) reject(err);
			else resolve(value);
		};
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const nl = buffered.indexOf(0x0a);
			if (nl < 0) {
				if (buffered.length > MAX_LINE_BYTES) done(new Error('invite message too long'));
				return;
			}
			try {
				done(null, JSON.parse(buffered.subarray(0, nl).toString('utf8')));
			} catch {
				done(new Error('malformed invite message'));
			}
		};
		const onEnd = (): void => done(null, null);
		const onError = (err: Error): void => done(err);
		const timer = setTimeout(() => done(new Error('invite exchange timed out')), timeoutMs);
		socket.on('data', onData);
		socket.once('end', onEnd);
		socket.once('error', onError);
		socket.resume();
	});
}

/** Answer one guest on a socket the founder's node took over, and close it. */
export async function answerGuest(socket: net.Socket, answer: (message: unknown) => Promise<OverlayInviteAnswer>): Promise<void> {
	try {
		const message = await readJSONLine(socket);
		const reply = await answer(message).catch((err: any): OverlayInviteAnswer => ({ status: 'refused', reason: String(err?.message ?? err).slice(0, 200) }));
		socket.end(JSON.stringify(reply) + '\n');
	} catch {
		socket.destroy();
	}
}

/** The invited node's side: hand the message to the founder through the guest helper's bridge and read the answer. */
export async function askFounder(bridge: { dialPort: number; token: string }, founderIP: string, message: OverlayInviteMessage): Promise<OverlayInviteAnswer> {
	const socket = net.connect({ host: '127.0.0.1', port: bridge.dialPort, noDelay: true });
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', resolve);
			socket.once('error', reject);
		});
		socket.pause();
		socket.write(`${bridge.token} ${founderIP}:${OVERLAY_LIBP2P_PORT}\n`);
		const ok = await readLine(socket);
		if (ok !== 'OK') throw new Error(`the founder is not reachable: ${ok.replace(/^ERR /, '')}`);
		socket.write(JSON.stringify(message) + '\n');
		const answer = await readJSONLine(socket);
		if (!answer || !['pending', 'approved', 'refused'].includes(answer.status)) throw new Error('the founder gave no answer');
		return answer as OverlayInviteAnswer;
	} finally {
		socket.destroy();
	}
}

/** The bridge's `OK`/`ERR` line, leaving what follows it in the socket. */
function readLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const done = (err: Error | null, line = ''): void => {
			clearTimeout(timer);
			socket.off('data', onData);
			socket.off('close', onClose);
			socket.off('error', onError);
			socket.pause();
			if (err) reject(err);
			else resolve(line);
		};
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const nl = buffered.indexOf(0x0a);
			if (nl < 0) return buffered.length > 256 ? done(new Error('bridge answer too long')) : undefined;
			const rest = buffered.subarray(nl + 1);
			if (rest.length > 0) socket.unshift(rest);
			done(null, buffered.subarray(0, nl).toString('utf8'));
		};
		const onClose = (): void => done(new Error('the bridge closed the connection'));
		const onError = (err: Error): void => done(err);
		const timer = setTimeout(() => done(new Error('the bridge did not answer in time')), EXCHANGE_TIMEOUT_MS);
		socket.on('data', onData);
		socket.once('close', onClose);
		socket.once('error', onError);
		socket.resume();
	});
}
