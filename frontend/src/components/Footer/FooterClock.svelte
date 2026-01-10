<script lang="ts">
	import { onMount } from 'svelte';
	let time = $state(getTime());

	function getTime(): string {
		const now = new Date();
		return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	onMount(() => {
		const interval = setInterval(() => {
			time = getTime();
		}, 1000);
		return () => clearInterval(interval);
	});
</script>

<span class="clock">{time}</span>
