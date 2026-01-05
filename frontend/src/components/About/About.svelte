<script lang="ts">
	import { onMount } from 'svelte';
	import { registerScene, activateScene } from '../../scripts/scenes.ts';
	import { focusArea, focusHeader } from '../../scripts/navigation.ts';
	import { productName, productVersion, buildDate, commitHash } from '../../scripts/app.ts';
	import Dialog from '../Dialog/Dialog.svelte';
	import ButtonNormal from '../Buttons/ButtonNormal.svelte';
	const SCENE_ID = 'about';
	const ITEMS = [
		{
			type: 'link',
			label: 'GitHub: https://github.com/libersoft-org/libershare',
			url: 'https://github.com/libersoft-org/libershare',
		},
		{
			type: 'link',
			label: 'Website: https://libershare.com',
			url: 'https://libershare.com',
		},
		{
			type: 'button',
			label: 'OK',
		},
	] as const;

	interface Props {
		onback?: () => void;
	}

	let { onback }: Props = $props();
	let active = $derived($focusArea === 'content');
	let selectedIndex = $state(ITEMS.length - 1); // Start on OK button
	let isAPressed = $state(false);

	function handleConfirm() {
		const item = ITEMS[selectedIndex];
		if (item.type === 'link') window.open(item.url, '_blank');
		else onback?.();
	}

	onMount(() => {
		const unregister = registerScene(SCENE_ID, {
			up: () => {
				if (selectedIndex > 0) selectedIndex--;
				else focusHeader();
			},
			down: () => {
				if (selectedIndex < ITEMS.length - 1) selectedIndex++;
			},
			confirmDown: () => {
				isAPressed = true;
			},
			confirmUp: () => {
				isAPressed = false;
				handleConfirm();
			},
			confirmCancel: () => {
				isAPressed = false;
			},
			back: () => onback?.(),
		});
		activateScene(SCENE_ID);
		return unregister;
	});
</script>

<style>
	.title {
		font-size: 1.8vw;
		font-weight: bold;
		color: #fd1;
	}

	.build {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vw;
		font-size: 1vw;
		color: #aaa;
	}

	.build .row {
		display: flex;
		gap: 0.5vw;
	}

	.build .row .label {
		color: #888;
	}

	.build .row .value {
		color: #fff;
	}

	.links {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vw;
		margin-top: 1vw;
	}

	.links .link {
		color: #aaa;
		text-decoration: none;
		font-size: 1vw;
		padding: 0.5vw;
		border-radius: 0.5vw;
		transition:
			background-color 0.15s,
			color 0.15s;
	}

	.links .link.selected {
		color: #fd1;
		background-color: rgba(255, 221, 17, 0.1);
	}

	.links .link.pressed {
		background-color: rgba(255, 221, 17, 0.2);
	}

	.buttons {
		margin-top: 1vw;
	}
</style>

<Dialog>
	<div class="title">{productName}</div>
	<div class="build">
		<div class="row">
			<span class="label">Version:</span>
			<span class="value">{productVersion}</span>
		</div>
		<div class="row">
			<span class="label">Build Date:</span>
			<span class="value">{buildDate}</span>
		</div>
		<div class="row">
			<span class="label">Commit:</span>
			<span class="value">{commitHash}</span>
		</div>
	</div>
	<div class="links">
		{#each ITEMS as item, i}
			{#if item.type === 'link'}
				<span class="link" class:selected={active && selectedIndex === i} class:pressed={active && selectedIndex === i && isAPressed}>
					{item.label}
				</span>
			{/if}
		{/each}
	</div>
	<div class="buttons">
		<ButtonNormal label="OK" selected={active && selectedIndex === ITEMS.length - 1} pressed={active && selectedIndex === ITEMS.length - 1 && isAPressed} />
	</div>
</Dialog>
