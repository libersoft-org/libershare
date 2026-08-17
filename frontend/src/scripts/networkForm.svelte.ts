import { untrack } from 'svelte';
import { get } from 'svelte/store';
import type { NetIPv4Config, NetworkStateInfo } from '@shared';
import { applyInterfaceConfig, interfaceForm, joinWifiNetwork, networkState, reseedDecision, type InterfaceForm } from './networkState.ts';

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

	/**
	 * Take the state an apply or a join ANSWERED with as the new basis.
	 *
	 * Clearing `seeded` and waiting for the effect to re-seed was what this used to
	 * do, and it leaves the form in a state nothing should be relied on to repair.
	 * Measured against Svelte 5.56: the RPC helper stores the answer synchronously, so
	 * the effect below has already run by the time the `await` resumes — and it has
	 * compared an EDITED form against the old basis and set `stale`. The continuation
	 * then clears the basis, which does happen to schedule that effect once more, so
	 * one microtask later it re-seeds and the damage undoes itself.
	 *
	 * "Happens to" is the problem. `seeded` is read inside `untrack`, so nothing
	 * documents that writing it re-runs the effect at all; it simply does in this
	 * version. A form whose basis is correct only after an extra scheduler turn, and
	 * only because a read that asked not to be tracked was tracked anyway, is one
	 * Svelte can break in a patch release. Seeding from the answer settles the basis,
	 * the staleness and the fields together, on the spot, and shows whatever the host
	 * normalised or refused without waiting for anything.
	 *
	 * Does nothing when the answer does not describe this interface — it may have been
	 * renamed, removed, or taken over by another stack by the time the apply returned.
	 */
	seedFromState(state: NetworkStateInfo, interfaceID: string): void {
		const source = state.interfaces.find(candidate => candidate.id === interfaceID);
		if (source) this.seed(interfaceForm(source));
	}

	/**
	 * Apply a configuration and settle the form on the state the host answered with.
	 *
	 * The RPC and the seeding live together here rather than in the component because
	 * their ORDER is the whole of what went wrong once already, and a test that
	 * hand-copies the two lines out of the handler pins its own copy rather than the
	 * one that ships. There is nothing else in it: the caller keeps the capability
	 * checks, the validation and the message, which are its own.
	 */
	async apply(interfaceID: string, config: NetIPv4Config): Promise<void> {
		this.seedFromState(await applyInterfaceConfig(interfaceID, config), interfaceID);
	}

	/**
	 * Join a Wi-Fi network and take the state it answered with as the new basis.
	 *
	 * The interface is on a different network afterwards, very possibly with a
	 * different addressing mode, so whatever the form held describes the network that
	 * was left. `ssid` is a value rather than something read back off the screen: the
	 * caller may not re-read a live binding the user can move while this is in flight.
	 */
	async join(interfaceID: string, ssid: string, password: string): Promise<void> {
		this.seedFromState(await joinWifiNetwork(interfaceID, ssid, password), interfaceID);
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
				if (decision === 'ignore') {
					// The host is back on the basis this form was seeded from — A to B and back
					// to A is the ordinary shape of a failed apply somebody else undid. Leaving
					// `stale` set from the trip through B kept Save blocked on a form whose basis
					// had returned, with no way to unblock it but reopening the screen.
					this.stale = false;
					return;
				}
				if (decision === 'stale') {
					this.stale = true;
					return;
				}
				this.seed(live);
			});
		});
	}
}
