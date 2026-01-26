<script lang="ts">
	import { onMount } from 'svelte';
	import { timeFormat, showSeconds } from '../../scripts/settings.ts';
	import { formatTime } from '../../scripts/utils.ts';
	let time = $state(formatTime(!$timeFormat, $showSeconds));

	onMount(() => {
		const interval = setInterval(() => (time = formatTime(!$timeFormat, $showSeconds)), 1000);
		return () => clearInterval(interval);
	});
</script>

<style>
	.clock {
		text-align: center;
	}
</style>

<span class="clock">{time}</span>
