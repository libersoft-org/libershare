<script lang="ts">
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { api } from '../../scripts/api.ts';
	import { isHostPort, type LISHNetworkConfig } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onCreated?: ((network: LISHNetworkConfig) => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onCreated }: Props = $props();
	let name = $state('');
	let description = $state('');
	let lighthouseAddr = $state('');
	let lanDirect = $state(false);
	let busy = $state(false);
	let submitted = $state(false);
	let error = $state('');
	let validation = $derived(!name.trim() ? $t('settings.lishNetwork.errorNameRequired') : lighthouseAddr.trim() && !isHostPort(lighthouseAddr.trim()) ? $t('settings.lishNetwork.protected.addrInvalid') : '');

	async function create(): Promise<void> {
		submitted = true;
		if (validation || busy) return;
		busy = true;
		error = '';
		try {
			const network = await api.overlay.create({ name: name.trim(), description, lanDirect, ...(lighthouseAddr.trim() ? { lighthouseAddr: lighthouseAddr.trim() } : {}) });
			addNotification(tt('settings.lishNetwork.protected.created', { name: network.name }), 'success');
			onCreated?.(network);
		} catch (e) {
			error = translateError(e);
		} finally {
			busy = false;
		}
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.create {
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

	.hint {
		font-size: 1.8vh;
		color: var(--disabled-foreground);
	}
</style>

<div class="create">
	<div class="container">
		<Alert type="info" message={$t('settings.lishNetwork.protected.createInfo')} />
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={name} label={$t('common.name')} position={[0, 0]} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={description} label={$t('common.description')} multiline rows={3} position={[0, 1]} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={lighthouseAddr} label={$t('settings.lishNetwork.protected.lighthouseAddr')} placeholder="203.0.113.7:4242" position={[0, 2]} />
		</div>
		<div class="hint">{$t('settings.lishNetwork.protected.lighthouseHint')}</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.lishNetwork.protected.lanDirect') + ':'} checked={lanDirect} position={[0, 3]} onToggle={() => (lanDirect = !lanDirect)} />
		</div>
		<Alert type="error" message={submitted && validation ? validation : error} />
	</div>
	<ButtonBar justify="center" basePosition={[0, 4]}>
		<Button icon="/img/lock.svg" label={$t('common.add')} disabled={busy} onConfirm={create} />
		<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
	</ButtonBar>
</div>
