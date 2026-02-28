type EmitFn = (client: any, event: string, data: any) => void;
type GetPeerCountsFn = () => { networkID: string; count: number }[];

interface EventsHandlers {
	subscribe: (p: { events?: string[]; event?: string }, client: any) => boolean;
	unsubscribe: (p: { events?: string[]; event?: string }, client: any) => boolean;
}

export function initEventsHandlers(getPeerCounts: GetPeerCountsFn, emit: EmitFn): EventsHandlers {
	function subscribe(p: { events?: string[]; event?: string }, client: any): boolean {
		const events = (Array.isArray(p.events) ? p.events : [p.event]).filter((e): e is string => e !== undefined);
		events.forEach(e => client.data.subscribedEvents.add(e));
		if (client.data.subscribedEvents.has('peers:count')) {
			const counts = getPeerCounts();
			if (counts.length > 0) emit(client, 'peers:count', counts);
		}
		return true;
	}

	function unsubscribe(p: { events?: string[]; event?: string }, client: any): boolean {
		const events = (Array.isArray(p.events) ? p.events : [p.event]).filter((e): e is string => e !== undefined);
		events.forEach(e => client.data.subscribedEvents.delete(e));
		return true;
	}

	return { subscribe, unsubscribe };
}
