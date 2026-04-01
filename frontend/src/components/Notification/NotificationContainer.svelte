<script lang="ts">
	import { onMount } from 'svelte';
	import { notifications } from '../../scripts/notifications.ts';
	import { footerVisible } from '../../scripts/settings.ts';
	import Notification from './Notification.svelte';
	const MARGIN = '2vh';
	let footerHeight = $state(0);
	let bottomOffset = $derived($footerVisible && footerHeight > 0 ? `calc(${footerHeight}px + ${MARGIN})` : MARGIN);

	onMount(() => {
		const footer = document.querySelector('[data-footer]');
		if (!footer) return;
		const observer = new ResizeObserver(() => (footerHeight = footer.getBoundingClientRect().height));
		observer.observe(footer);
		return () => observer.disconnect();
	});
</script>

<style>
	.container {
		z-index: 5000;
		position: fixed;
		right: 2vh;
		display: flex;
		flex-direction: column;
		gap: 1vh;
		pointer-events: none;
	}
</style>

{#if $notifications.length > 0}
	<div class="container" style="bottom: {bottomOffset}">
		{#each $notifications as notification (notification.id)}
			<Notification id={notification.id} text={notification.text} type={notification.type} />
		{/each}
	</div>
{/if}
