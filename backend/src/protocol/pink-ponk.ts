// Pink/Ponk: debug heartbeat protocol for network testing.
export const PINK_TOPIC = 'pink';
export const PONK_TOPIC = 'ponk';

export interface PinkMessage {
	type: 'pink';
	peerID: string;
	timestamp: number;
}

export interface PonkMessage {
	type: 'ponk';
	peerID: string;
	timestamp: number;
	inReplyTo: string;
}

export function createPinkMessage(peerID: string): PinkMessage {
	return { type: 'pink', peerID, timestamp: Date.now() };
}

export function createPonkMessage(peerID: string, inReplyTo: string): PonkMessage {
	return { type: 'ponk', peerID, timestamp: Date.now(), inReplyTo };
}
