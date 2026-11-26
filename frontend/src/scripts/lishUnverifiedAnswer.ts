import { api } from './api.ts';
import { type UnverifiedOffer } from './lishVerification.ts';

/**
 * Send the user's answer for the LISHs the backend is holding. Returns how many were added.
 * Agreeing stops at the first one the backend refuses; a refusal is best effort, since the
 * backend lets a held LISH go on its own after a while.
 */
export async function answerUnverifiedOffers(offers: readonly UnverifiedOffer[], accept: boolean): Promise<number> {
	let added = 0;
	for (const offer of offers) {
		if (!offer.token) continue;
		if (accept) {
			if (await api.lishs.answerUnverified(offer.token, true)) added++;
		} else await api.lishs.answerUnverified(offer.token, false).catch(() => {});
	}
	return added;
}
