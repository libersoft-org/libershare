<script lang="ts">
	import { productVersion } from '../../scripts/app.ts';
</script>

<style>
	.footer {
		display: flex;
		align-items: center;
		background-color: var(--secondary-background);
		color: var(--primary-foreground);
		padding: 2vh;
		font-size: 2vh;
	}
</style>

<div class="footer">
	Version: {productVersion}
</div>
