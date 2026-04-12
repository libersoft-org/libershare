<script lang="ts">
	import { type EnabledMode } from '../../scripts/downloads.ts';
	interface Props {
		mode?: EnabledMode | undefined;
		size?: string;
	}
	let { mode = 'disabled', size = '2.4vh' }: Props = $props();
</script>

<style>
	.mode-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.1vh;
	}
</style>

{#if mode === 'both'}
	<span class="mode-icon">
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<path d="M8 2v11M4 8.5L8 13l4-4.5" stroke="var(--mode-download-fg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<path d="M8 14V3M4 7.5L8 3l4 4.5" stroke="var(--mode-upload-fg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
	</span>
{:else if mode === 'download'}
	<span class="mode-icon">
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<path d="M8 2v11M4 8.5L8 13l4-4.5" stroke="var(--mode-download-fg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
	</span>
{:else if mode === 'upload'}
	<span class="mode-icon">
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<path d="M8 14V3M4 7.5L8 3l4 4.5" stroke="var(--mode-upload-fg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
	</span>
{:else}
	<span class="mode-icon">
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<circle cx="8" cy="8" r="5.5" stroke="var(--mode-disabled-fg)" stroke-width="1.8"/>
			<path d="M5.2 5.2l5.6 5.6" stroke="var(--mode-disabled-fg)" stroke-width="1.8" stroke-linecap="round"/>
		</svg>
	</span>
{/if}
