<script lang="ts">
	import { productName } from '@shared';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { setFullscreenLocked } from '../../scripts/input/keyboard.ts';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position: Position;
		onBack?: () => void;
	}
	let { areaID, position, onBack }: Props = $props();

	function toggleFullscreen(): void {
		const tauri = (window as any).__TAURI_INTERNALS__;
		if (tauri) {
			tauri.invoke('app_fullscreen');
			return;
		}
		const kb = (navigator as any).keyboard;
		if (!document.fullscreenElement) {
			setFullscreenLocked(true);
			document.documentElement
				.requestFullscreen()
				.then(() => {
					// Chrome/Edge/Opera: lock Escape key so it doesn't exit fullscreen
					kb?.lock?.(['Escape']).catch(() => {});
				})
				.catch(() => {
					setFullscreenLocked(false);
				});
		} else {
			kb?.unlock?.();
			setFullscreenLocked(false);
			document.exitFullscreen().catch(() => {});
		}
	}

	createNavArea(() => ({ areaID, position, onBack }));
</script>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 1vh;
		padding: 1vh;
		background-color: var(--secondary-background);
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.title {
		color: var(--primary-foreground);
		font-size: 4vh;
		font-weight: bold;
	}

	.spacer {
		flex: 1;
	}
</style>

<div class="header">
	<Button icon="/img/back.svg" alt="Back" position={[0, 0]} onConfirm={onBack} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
	<div class="title">{productName}</div>
	<div class="spacer"></div>
	<Button icon="/img/fullscreen.svg" alt="Fullscreen" position={[1, 0]} onConfirm={toggleFullscreen} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
</div>
