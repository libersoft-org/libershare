<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Dialog from './Dialog.svelte';
	import ButtonBar from '../Buttons/ButtonBar.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		title: string;
		message: string;
		options: Array<{ value: string; label: string; icon?: string | undefined }>;
		/** Index of the option focused first. */
		initial?: number | undefined;
		position: Position;
		onChoose: (value: string) => void;
		onBack: () => void;
	}
	let { title, message, options, initial = 0, position, onChoose, onBack }: Props = $props();

	createNavArea(() => ({ areaID: 'choice-dialog', position, activate: true, trap: true, onBack, initialPosition: [initial, 0] }));
</script>

<style>
	.choice {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3vh;
	}

	.message {
		font-size: 2vh;
		text-align: center;
		white-space: pre-line;
		line-height: 1.6;
	}
</style>

<Dialog {title}>
	<div class="choice">
		<div class="message">{message}</div>
		<ButtonBar justify="center" basePosition={[0, 0]}>
			{#each options as option (option.value)}
				<Button icon={option.icon} label={option.label} onConfirm={() => onChoose(option.value)} />
			{/each}
		</ButtonBar>
	</div>
</Dialog>
