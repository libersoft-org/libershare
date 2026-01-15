<script lang="ts">
	import { onMount } from 'svelte';
	import { timeFormat, showSeconds } from '../../scripts/settings.ts';
	let time = $state(getTime());

	function getTime(): string {
		const now = new Date();
		const options: Intl.DateTimeFormatOptions = {
			hour: 'numeric',
			minute: 'numeric',
			hour12: !$timeFormat,
		};
		if ($showSeconds) options.second = 'numeric';
		return now.toLocaleTimeString([], options);
	}

	onMount(() => {
		const interval = setInterval(() => (time = getTime()), 1000);
		return () => clearInterval(interval);
	});
</script>

<span class="clock">{time}</span>
