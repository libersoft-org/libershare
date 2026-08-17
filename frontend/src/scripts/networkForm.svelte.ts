import { untrack } from 'svelte';
import { get } from 'svelte/store';
import type { NetworkStateInfo } from '@shared';
import { interfaceForm, networkState, reseedDecision, type InterfaceForm } from './networkState.ts';

/**
 * The addressing form's fields and the basis they were seeded from.
 *
 * Lives here rather than in the editor component because the ORDERING is the whole
 * of the logic and the ordering is what went wrong: a store update, the `$effect`
 * Svelte schedules from it, and the continuation of an `await` all have to
 * interleave correctly, and none of that can be exercised through the pure decision
 * function alone. As a rune module it is the same code the component runs, driven
 * by the same scheduler, and a test can step through it.
 */
export class InterfaceFormState {
	mode = $state<InterfaceForm['mode']>('unknown');
	address = $state('');
	prefix = $state('24');
	gateway = $state('');
	dns = $state('');

	/**
	 * The configuration the form was seeded from, so a later broadcast can be
	 * compared against it. Null until the first one arrives.
	 */
	seeded = $state<InterfaceForm | null>(null);
	/**
	 * True once the host's configuration has moved away from what an EDITED form was
	 * seeded from. Save is then refusing to write a basis that no longer exists.
	 */
	stale = $state(false);

	/** What is on screen right now, for comparison against a fresh reading. */
	get onScreen(): InterfaceForm {
		return { mode: this.mode, address: this.address, prefix: this.prefix, gateway: this.gateway, dns: this.dns };
	}

	/** Take a reading as the form's new basis, discarding whatever was typed. */
	seed(form: InterfaceForm): void {
		this.seeded = form;
		this.stale = false;
		this.mode = form.mode;
		this.address = form.address;
		this.prefix = form.prefix;
		this.gateway = form.gateway;
		this.dns = form.dns;
	}

	/** Take the state an apply or a join answered with as the form's new basis. */
	reseed(): void {
		this.seeded = null;
		this.stale = false;
	}

	/**
	 * Follow the host while the form is untouched, and refuse to overwrite it once
	 * it is not.
	 *
	 * Seeding exactly once was the whole of this, and it made Save write a
	 * configuration the user was no longer looking at. A Wi-Fi join replaces the
	 * whole network state — the interface can go from a static address to the DHCP
	 * one the new network handed out — while the form kept the old network's
	 * address, and the next Save wrote it into the new network's profile. The same
	 * lost update arrives from the Windows network UI, from NetworkManager, or from
	 * a second client of this app.
	 *
	 * So: unchanged host, leave the form alone. Changed host and a clean form,
	 * follow it. Changed host and a form the user has edited, keep what they typed —
	 * throwing away typing is its own kind of data loss — and block Save, because
	 * the basis it would be written against is gone.
	 */
	watch(getInterfaceID: () => string): void {
		// Bridged into a rune by hand rather than with `fromStore`, which only tracks
		// when it is CALLED from inside a tracking effect — and this runs at component
		// init, where it is not. It then answers with a plain read of the store and
		// nothing below ever re-runs, so the form followed the first reading and no
		// other. The subscription hangs off an effect of its own so it is torn down
		// with the component; that effect reads nothing reactive, so it runs once.
		let host = $state<NetworkStateInfo>(get(networkState));
		$effect(() => networkState.subscribe(value => (host = value)));
		$effect(() => {
			const source = host.interfaces.find(candidate => candidate.id === getInterfaceID());
			if (!source) return;
			const live = interfaceForm(source);
			// Everything below reads the form fields, which this effect must not follow —
			// it answers to the HOST changing, not to the user typing.
			untrack(() => {
				const decision = reseedDecision(this.seeded, live, this.onScreen);
				if (decision === 'ignore') return;
				if (decision === 'stale') {
					this.stale = true;
					return;
				}
				this.seed(live);
			});
		});
	}
}
