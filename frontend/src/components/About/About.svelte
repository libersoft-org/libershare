<script lang="ts">
	import { onMount } from 'svelte';
	import { registerScene, activateScene } from '../../scripts/scenes.ts';
	import { focusArea, focusHeader } from '../../scripts/navigation.ts';
	import { productName, productVersion, buildDate, commitHash } from '../../scripts/app.ts';
	import Dialog from '../Dialog/Dialog.svelte';
	import ButtonNormal from '../Buttons/ButtonNormal.svelte';
	const SCENE_ID = 'about';

	interface Props {
		onback?: () => void;
	}

	let { onback }: Props = $props();
	let active = $derived($focusArea === 'content');
	let selectedIndex = $state(2); // Start on OK button
	let isAPressed = $state(false);
	let buttons: { onConfirm?: () => void }[] = [];

	function openUrl(url: string) {
		console.log('Opening URL:', url);
		window.open(url, '_blank');
	}

	onMount(() => {
		const unregister = registerScene(SCENE_ID, {
			up: () => {
				if (selectedIndex > 0) selectedIndex--;
				else focusHeader();
			},
			down: () => {
				if (selectedIndex < 2) selectedIndex++;
			},
			confirmDown: () => {
				isAPressed = true;
			},
			confirmUp: () => {
				isAPressed = false;
				buttons[selectedIndex]?.onConfirm?.();
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
			<span class="label">Build date:</span>
			<span class="value">{buildDate}</span>
		</div>
		<div class="row">
			<span class="label">Commit:</span>
			<span class="value">{commitHash}</span>
		</div>
	</div>
	<div class="links">
		<ButtonNormal bind:this={buttons[0]} label="GitHub page" selected={active && selectedIndex === 0} pressed={active && selectedIndex === 0 && isAPressed} padding="0.5vw" fontSize="0.7vw" borderRadius="0.5vw" onConfirm={() => openUrl('https://github.com/libersoft-org/libershare')} />
		<ButtonNormal bind:this={buttons[1]} label="Official website" selected={active && selectedIndex === 1} pressed={active && selectedIndex === 1 && isAPressed} padding="0.5vw" fontSize="0.7vw" borderRadius="0.5vw" onConfirm={() => openUrl('https://libershare.com')} />
		<ButtonNormal bind:this={buttons[2]} label="OK" selected={active && selectedIndex === 2} pressed={active && selectedIndex === 2 && isAPressed} onConfirm={() => onback?.()} />
	</div>
</Dialog>
