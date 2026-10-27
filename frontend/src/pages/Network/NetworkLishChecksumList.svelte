<script lang="ts">
	interface Props {
		checksums: string[];
	}
	let { checksums }: Props = $props();
	// One text node rather than a row each: a large file has tens of thousands of chunks.
	let text = $derived(checksums.map((checksum, i) => `${i + 1}\t${checksum}`).join('\n'));
</script>

<style>
	.checksums {
		max-height: 30vh;
		overflow-y: auto;
		white-space: pre;
		font-family: var(--font-mono);
		font-size: 1.5vh;
	}
</style>

<div class="checksums">{text}</div>
