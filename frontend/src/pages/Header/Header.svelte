<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '@shared';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position: Position;
		onBack?: () => void;
	}
	let { areaID, position, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);

	function toggleFullscreen(): void {
		const tauri = (window as any).__TAURI_INTERNALS__;
		if (tauri) tauri.invoke('app_fullscreen');
		else {
			if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
			else document.exitFullscreen().catch(() => {});
		}
	}

	onMount(() => {
		return useArea(
			areaID,
			{
				up() {
					return false;
				},
				down() {
					return false;
				},
				left() {
					if (selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				right() {
					if (selectedIndex < 1) {
						selectedIndex++;
						return true;
					}
					return false;
				},
				confirmUp() {
					if (selectedIndex === 0) onBack?.();
					else toggleFullscreen();
				},
				back() {
					onBack?.();
				},
			},
			position
		);
	});
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
	<Button icon="/img/back.svg" alt="Back" selected={active && selectedIndex === 0} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
	<div class="title">{productName}</div>
	<div class="spacer"></div>
	<div class="debug-hint">
		<div>F2 / START = debug</div>
		<div>F3 / SELECT = reload</div>
	</div>
	<Button icon="/img/fullscreen.svg" alt="Fullscreen" selected={active && selectedIndex === 1} padding="1vh" width="5vh" height="5vh" borderRadius="50%" onConfirm={toggleFullscreen} />
</div>
