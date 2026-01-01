<script lang="ts">
	import { productVersion } from '../../scripts/app.ts';
</script>

<style>
	.footer {
		display: flex;
		align-items: center;
		background-color: #000;
		color: #fd1;
		padding: 1vw;
		font-size: 1.5vw;
	}
</style>

<div class="footer">
	Version: {productVersion}
</div>
