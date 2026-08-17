/**
 * The network editor's form state, driven through the real Svelte scheduler.
 *
 * `reseedDecision` is a pure function and is tested as one in `network-state`.
 * That test cannot catch what this one is for. The defect it missed lives in the
 * ORDER three things happen in: the RPC helper stores the answer, which notifies
 * the store SYNCHRONOUSLY; Svelte schedules the `$effect` for a microtask later;
 * and only then does the `await` in the caller resume. So by the time a Save
 * handler runs its next line, the effect has already compared an edited form
 * against the old basis and marked it stale. Nothing about that sequence is
 * visible to a test that calls the decision function itself.
 *
 * So the state runs here exactly as the component runs it — the same rune module,
 * the same store, the same effect — inside an `$effect.root` standing in for the
 * component instance. `await tick()` is where Svelte's scheduler gets its turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tick } from 'svelte';
import type { NetInterfaceInfo, NetworkStateInfo } from '@shared';
import type { InterfaceForm } from '../../src/scripts/networkState.ts';
import { apiHandlers, resetAPIMock } from '../api-mock.ts';
import { InterfaceFormState } from '../../src/scripts/networkForm.svelte.ts';
import { networkState, unknownNetworkState } from '../../src/scripts/networkState.ts';

/** What the next `system.networkApply` answers with. */
let answer: NetworkStateInfo;

// The real RPC helper is what makes the ordering real: it stores the answer and
// only then resolves, so the effect is already scheduled by the time the caller's
// await resumes. Stubbing the helper instead of the transport would have invented
// a different number of microtask hops and quietly tested nothing. The transport
// itself is the suite-wide fake — see `tests/api-mock.ts` for why it may not be
// replaced per file.
beforeEach(() => {
	resetAPIMock();
	apiHandlers.call = async () => answer;
});

function iface(overrides: Partial<NetInterfaceInfo> = {}): NetInterfaceInfo {
	return { id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], ipv4Configurable: true, wifiScannable: true, wifiConnectable: true, ...overrides };
}

function snapshot(source: NetInterfaceInfo): NetworkStateInfo {
	return { interfaces: [source], primaryID: 'eth0', detail: 'full', known: true, capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false } };
}

const roots: Array<() => void> = [];

afterEach(() => {
	for (const stop of roots.splice(0)) stop();
	networkState.set(unknownNetworkState());
});

/** An editor instance: the form state, watching the store, as the component sets it up. */
function editor(): InstanceType<typeof InterfaceFormState> {
	let form!: InstanceType<typeof InterfaceFormState>;
	roots.push(
		$effect.root(() => {
			form = new InterfaceFormState();
			form.watch(() => 'eth0');
		})
	);
	return form;
}

/**
 * What the component's Save handler runs, plus a reading of the basis taken on the
 * SAME tick as the seeding.
 *
 * `form.apply()` is the production call, not a copy of its two lines: the ordering
 * is the whole of what this file exists to pin, and a hand-copied helper pins the
 * copy instead. What stays in the component is the capability checks, the
 * validation and the message.
 *
 * The basis reading is the discriminating one. Clearing the basis instead leaves it
 * null here and lets the effect repair it a microtask later — so an assertion made
 * after any `await` sees the same thing either way, and pins nothing.
 */
async function save(form: InstanceType<typeof InterfaceFormState>, resulting: NetworkStateInfo): Promise<{ seeded: InterfaceForm | null; stale: boolean }> {
	answer = resulting;
	await form.apply('eth0', { mode: 'dhcp' });
	return { seeded: form.seeded, stale: form.stale };
}

describe('InterfaceFormState', () => {
	it('seeds the form from the first reading of the host', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		expect(form.onScreen).toEqual({ mode: 'static', address: '192.0.2.10', prefix: '24', gateway: '192.0.2.1', dns: '' });
		expect(form.stale).toBe(false);
	});

	// The whole point of this file. A successful Save used to clear the basis and let
	// the next effect run re-seed from the store. By the time it did, the effect had
	// already run once against the OLD basis and set `stale` — so between the apply
	// answering and the scheduler's next turn the form was marked unsaveable and had
	// no basis at all. It repairs itself, but only because writing `seeded` re-runs an
	// effect that read it under `untrack` and therefore asked not to be re-run; that
	// is not behaviour to build on. Settling it on the spot needs no scheduler turn
	// and no such assumption.
	it('takes the state an apply answered with as the new basis', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		// The user edits, then saves.
		form.address = '192.0.2.50';
		const settled = await save(form, snapshot(iface({ addresses: [{ family: 'ipv4', address: '192.0.2.50', prefixLength: 24 }] })));
		// Read on the same tick as the seeding — see `save`.
		expect(settled.seeded).toEqual(form.onScreen);
		expect(settled.stale).toBe(false);
		expect(form.address).toBe('192.0.2.50');
		// And the effect the store update scheduled must not undo any of that when it
		// finally runs.
		await tick();
		expect(form.stale).toBe(false);
		expect(form.address).toBe('192.0.2.50');
	});

	// The consequence a missing basis would have: having saved, the user starts typing
	// the next change and the ordinary ten-second broadcast arrives. With no basis
	// recorded the decision is `reseed` unconditionally and the typing goes away
	// without a word.
	it('keeps what was typed after a save when the next broadcast arrives', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		await save(form, snapshot(iface()));
		await tick();
		form.gateway = '192.0.2.99';
		// The next poll reports exactly what the apply already answered with.
		networkState.set(snapshot(iface()));
		await tick();
		expect(form.gateway).toBe('192.0.2.99');
	});

	// The host normalising or refusing part of the request has to show up immediately,
	// not at the next poll: the user is looking at the screen that just said "saved".
	it('shows what the host actually did rather than what was asked for', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		form.dns = '198.51.100.1, 127.0.0.53';
		// The host kept only the real resolver.
		await save(form, snapshot(iface({ dns: ['198.51.100.1'] })));
		expect(form.dns).toBe('198.51.100.1');
	});

	it('follows the host while the form is untouched', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		networkState.set(snapshot(iface({ gateway: '192.0.2.254' })));
		await tick();
		expect(form.gateway).toBe('192.0.2.254');
		expect(form.stale).toBe(false);
	});

	it('keeps an edited form and blocks Save when the host moves under it', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		form.address = '192.0.2.77';
		networkState.set(snapshot(iface({ gateway: '192.0.2.254' })));
		await tick();
		expect(form.address).toBe('192.0.2.77');
		expect(form.stale).toBe(true);
	});

	// A to B and back to A — a failed apply somebody else undid, or a link that
	// flapped. The decision for the final state is `ignore`, and `ignore` used to
	// leave `stale` exactly as the trip through B had set it. Save then stayed blocked
	// on a form whose basis had returned, with no way out but reopening the screen.
	it('unblocks Save when the host returns to the basis the form was seeded from', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		form.address = '192.0.2.77';
		networkState.set(snapshot(iface({ gateway: '192.0.2.254' })));
		await tick();
		expect(form.stale).toBe(true);
		networkState.set(snapshot(iface()));
		await tick();
		expect(form.stale).toBe(false);
		expect(form.address).toBe('192.0.2.77');
	});

	// A join is the same ordering problem as a save and used to be a second copy of
	// the same two lines. It matters more here: a join replaces the whole network
	// state, so the form is guaranteed to be looking at the network that was left.
	it('takes the state a join answered with as the new basis', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		form.address = '192.0.2.77';
		answer = snapshot(iface({ ipv4Mode: 'dhcp', addresses: [{ family: 'ipv4', address: '203.0.113.40', prefixLength: 24 }], gateway: '203.0.113.1' }));
		await form.join('eth0', 'some-network', 'secret');
		expect(form.seeded).toEqual(form.onScreen);
		expect(form.stale).toBe(false);
		expect(form.onScreen.mode).toBe('dhcp');
		expect(form.onScreen.address).toBe('203.0.113.40');
	});

	// The SSID is a value the caller passes, never something read back off the screen
	// after the await: the user can arm a different network while the join is in
	// flight, and the request went to one network while the message named another.
	it('joins the network it was given rather than whatever is armed later', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		let requested: unknown = null;
		apiHandlers.call = async (_method, params) => {
			requested = params;
			return snapshot(iface());
		};
		await form.join('eth0', 'first-network', 'secret');
		expect(requested).toEqual({ interfaceID: 'eth0', ssid: 'first-network', password: 'secret' });
	});

	// The interface can be gone by the time the RPC answers — renamed, removed, or
	// taken over by another stack. There is then nothing to seed from, and inventing a
	// basis would be worse than keeping none.
	it('leaves the basis alone when the answer does not describe this interface', async () => {
		const form = editor();
		networkState.set(snapshot(iface()));
		await tick();
		const before = form.seeded;
		form.seedFromState(snapshot(iface({ id: 'eth1' })), 'eth0');
		expect(form.seeded).toEqual(before);
	});
});
