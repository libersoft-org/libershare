<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		width?: string;
		align?: 'left' | 'center' | 'right';
		desktopOnly?: boolean;
		wrap?: boolean;
	}
	let { children, width, align = 'left', desktopOnly = false, wrap = false }: Props = $props();
	let justifyContent = $derived(align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center');
</script>

<style>
	.cell {
		display: flex;
		align-items: center;
		font-size: inherit;
		min-width: 0;
	}

	.content {
		width: 100%;
		text-overflow: ellipsis;
		white-space: nowrap;
		overflow: hidden;
	}

	.content.wrap {
		white-space: normal;
		word-break: break-all;
		text-overflow: unset;
	}

	@media (max-width: 1199px) {
		.cell.desktop-only {
			display: none;
		}
	}
</style>

<div class="cell" class:desktop-only={desktopOnly} style="width: {width ?? 'auto'}; justify-content: {justifyContent}; text-align: {align};">
	<div class="content" class:wrap>{@render children()}</div>
</div>
