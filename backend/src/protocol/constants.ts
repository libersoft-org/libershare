/**
 * Protocol-level constants shared across protocol modules.
 */

/**
 * Returns the pubsub topic name for a given lishnet/network ID.
 */
export function lishTopic(networkID: string): string {
	return `lish/${networkID}`;
}
