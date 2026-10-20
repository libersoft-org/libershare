<script lang="ts">
	import { untrack } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { type OverlayStatus } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		/** The lishnet was added and its request is on its way; the caller shows its access page. */
		onJoined?: ((status: OverlayStatus) => void) | undefined;
		/** The name a member coming back already asked as. */
		defaultName?: string | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onJoined, defaultName = '' }: Props = $props();
	let invite = $state('');
	let name = $state(untrack(() => defaultName));
	let busy = $state(false);
	let submitted = $state(false);
	let error = $state('');
	let validation = $derived(!invite.trim() ? $t('settings.lishNetwork.protected.errorInviteRequired') : !name.trim() ? $t('settings.lishNetwork.errorNameRequired') : '');

	async function join(): Promise<void> {
		submitted = true;
		if (validation || busy) return;
		busy = true;
		error = '';
		try {
			onJoined?.(await api.overlay.useInvite(invite.trim(), name.trim()));
		} catch (e) {
			error = translateError(e);
		} finally {
			busy = false;
		}
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.invite {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}
</style>

<div class="invite">
	<div class="container">
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={invite} label={$t('settings.lishNetwork.protected.inviteCode')} multiline rows={3} fontSize="1.6vh" fontFamily="var(--font-mono)" placeholder="lishinvite:..." position={[0, 0]} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={name} label={$t('settings.lishNetwork.protected.yourName')} position={[0, 1]} />
		</div>
		<Alert type="error" message={submitted && validation ? validation : error} />
	</div>
	<ButtonBar justify="center" basePosition={[0, 2]}>
		<Button icon="/img/link.svg" label={$t('settings.lishNetwork.protected.join')} disabled={busy} onConfirm={join} />
		<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
	</ButtonBar>
</div>
