<script lang="ts">
	import { productName } from '@shared';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position: Position;
		onBack?: () => void;
	}
	let { areaID, position, onBack }: Props = $props();

	function toggleFullscreen(): void {
		const tauri = (window as any).__TAURI_INTERNALS__;
		if (tauri) tauri.invoke('app_fullscreen');
		else {
			if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
			else document.exitFullscreen().catch(() => {});
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

	.debug-hint {
		text-align: right;
		color: var(--secondary-foreground);
		font-size: 1.4vh;
		opacity: 0.6;
		flex-shrink: 1;
		min-width: 0;
		overflow: hidden;
	}

	.debug-hint div {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

<div class="header">
	<Button icon="/img/back.svg" alt="Back" position={[0, 0]} onConfirm={onBack} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
	<div class="title">{productName}</div>
	<div class="spacer"></div>
	<div class="debug-hint">
		<div>F2 / START = debug</div>
		<div>F3 / SELECT = reload</div>
	</div>
	<Button icon="/img/fullscreen.svg" alt="Fullscreen" position={[1, 0]} onConfirm={toggleFullscreen} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
</div>
