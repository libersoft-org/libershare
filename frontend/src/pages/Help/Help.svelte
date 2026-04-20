<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	interface Binding {
		keys: string;
		action: string;
	}

	// Keyboard bindings — labels mirror keys in keyboard.ts
	let keyboardBindings = $derived<Binding[]>([
		{ keys: '↑ ↓ ← →', action: $t('help.actions.navigate') },
		{ keys: 'Enter / Space', action: $t('help.actions.confirm') },
		{ keys: 'Escape / Backspace', action: $t('help.actions.back') },
		{ keys: 'PageUp / PageDown', action: $t('help.actions.pageUpDown') },
		{ keys: 'Home / End', action: $t('help.actions.homeEnd') },
		{ keys: '+ / -', action: $t('help.actions.volume') },
		{ keys: 'F2', action: $t('help.actions.reload') },
		{ keys: 'A – Z, 0 – 9', action: $t('help.actions.typeAhead') },
	]);

	// Gamepad bindings — mirror mappings in gamepad.ts + input.ts
	let gamepadBindings = $derived<Binding[]>([
		{ keys: $t('help.gamepad.dpadOrStick'), action: $t('help.actions.navigate') },
		{ keys: 'A', action: $t('help.actions.confirm') },
		{ keys: 'B', action: $t('help.actions.back') },
		{ keys: 'X', action: $t('help.actions.volumeDown') },
		{ keys: 'Y', action: $t('help.actions.volumeUp') },
		{ keys: 'SELECT + A', action: $t('help.actions.pageDown') },
		{ keys: 'SELECT + B', action: $t('help.actions.pageUp') },
		{ keys: 'SELECT + X', action: $t('help.actions.end') },
		{ keys: 'SELECT + Y', action: $t('help.actions.home') },
		{ keys: 'START + Y', action: $t('help.actions.reload') },
	]);

	// Row Y positions: back = 0, keyboard rows start at 1, gamepad rows follow.
	let keyboardStartY = 1;
	let gamepadStartY = $derived(keyboardStartY + keyboardBindings.length);
	let lastRowY = $derived(gamepadStartY + gamepadBindings.length - 1);

	createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: () => [keyboardStartY, lastRowY],
	}));
</script>

<style>
	.help {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		min-height: 0;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
		box-sizing: border-box;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 3vh;
		width: 1000px;
		max-width: 100%;
	}

	.heading {
		font-size: 3vh;
		font-weight: bold;
		color: var(--primary-foreground);
		text-decoration: underline;
	}

	.subheading {
		font-size: 2.2vh;
		font-weight: bold;
		color: var(--primary-foreground);
		margin-bottom: 1vh;
	}

	.keys {
		font-family: var(--font-mono);
		font-weight: bold;
		white-space: nowrap;
	}
</style>

<div class="help">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
		</ButtonBar>
		<div class="heading">{$t('help.controls')}</div>
		<div>
			<div class="subheading">{$t('help.keyboard.title')}</div>
			<Table columns="30vh 1fr">
				{#each keyboardBindings as b, i}
					<TableRow position={[0, keyboardStartY + i]}>
						<TableCell><span class="keys">{b.keys}</span></TableCell>
						<TableCell>{b.action}</TableCell>
					</TableRow>
				{/each}
			</Table>
		</div>
		<div>
			<div class="subheading">{$t('help.gamepad.title')}</div>
			<Table columns="30vh 1fr">
				{#each gamepadBindings as b, i}
					<TableRow position={[0, gamepadStartY + i]}>
						<TableCell><span class="keys">{b.keys}</span></TableCell>
						<TableCell>{b.action}</TableCell>
					</TableRow>
				{/each}
			</Table>
		</div>
	</div>
</div>
