// Transient libp2p errors that can occur during normal peer churn, stream
// timeouts, connection drops, etc. These must not crash the process.
const TRANSIENT_ERRORS = new Set([
	// Stream errors (@libp2p/interface)
	'StreamStateError',
	'StreamResetError',
	'StreamAbortedError',
	'StreamBufferError',
	'StreamClosedError',
	// Connection errors (@libp2p/interface, libp2p core)
	'ConnectionClosedError',
	'ConnectionClosingError',
	'ConnectionFailedError',
	'ConnectionDeniedError',
	'ConnectionInterceptedError',
	// Muxer errors (@libp2p/interface, @chainsafe/libp2p-yamux)
	'MuxerClosedError',
	'MuxerUnavailableError',
	'InvalidFrameError',
	'ReceiveWindowExceededError',
	'InvalidStateError',
	'StreamAlreadyExistsError',
	'BothClientsError',
	// Dial errors (libp2p core)
	'DialError',
	'DialDeniedError',
	'NoValidAddressesError',
	'TransportUnavailableError',
	// Timeout & abort
	'AbortError',
	'TimeoutError',
	// Crypto / handshake (noise, relay)
	'EncryptionFailedError',
	'InvalidCryptoExchangeError',
	// Protocol / message errors from misbehaving peers
	'ProtocolError',
	'InvalidMessageError',
	'UnsupportedProtocolError',
	'UnexpectedPeerError',
	'UnexpectedEOFError',
	'InvalidMessageLengthError',
	'InvalidDataLengthError',
	// Resource limits
	'TooManyInboundProtocolStreamsError',
	'TooManyOutboundProtocolStreamsError',
	'QueueFullError',
	'RateLimitError',
	'LimitedConnectionError',
	// Relay limits (@libp2p/circuit-relay-v2)
	'TransferLimitError',
	'DurationLimitError',
	'RelayQueueFullError',
	'HadEnoughRelaysError',
	'DoubleRelayError',
]);

interface ErrorDetails {
	name?: string;
	constructor?: { name?: string };
	message?: string;
	context?: { message?: string };
	cause?: ErrorDetails;
	code?: string;
}

/** Explicit runtime names take priority; subclasses can inherit the generic Error name. */
export function errorName(error: unknown): string {
	const err = error as ErrorDetails | null | undefined;
	if (err?.name && err.name !== 'Error') return err.name;
	return err?.constructor?.name || err?.name || '';
}

export function isTransientError(error: unknown): boolean {
	const err = error as ErrorDetails | null | undefined;
	if (TRANSIENT_ERRORS.has(err?.name ?? '') || TRANSIENT_ERRORS.has(err?.constructor?.name ?? '')) return true;
	// Node EventEmitter wraps stream 'error' events with no listener as
	// `Error: Unhandled error.` libp2p stream/muxer paths emit DOMException
	// TimeoutError / AbortError on the underlying socket when a peer goes silent
	// and no listener is attached. Both forms are transient.
	const msg: string = err?.message ?? '';
	const ctxMsg: string = err?.context?.message ?? '';
	if (msg.startsWith('Unhandled error.') && /TimeoutError|AbortError|ECONNRESET|EPIPE/i.test(msg)) return true;
	if (msg.includes('Unhandled error') && (ctxMsg.includes('timed out') || ctxMsg.includes('aborted') || ctxMsg.includes('closed') || ctxMsg.includes('reset'))) return true;
	// Cause-chain check (Node may set .cause on wrapped errors).
	const causeNames = [err?.cause?.name, err?.cause?.constructor?.name];
	if (causeNames.some(name => name === 'TimeoutError' || name === 'AbortError')) return true;
	// A UDP discovery socket (SSDP behind UPnP NAT, mDNS) binding to an interface
	// address that is being reconfigured — just added and still tentative, or just
	// removed — fails with EADDRNOTAVAIL, and the library surfaces that as an
	// unhandled 'error' event. Seen live right after the app's own IPv4 change;
	// the host must survive its own network change.
	if (err?.code === 'EADDRNOTAVAIL' && /^bind /.test(msg)) return true;
	return false;
}
