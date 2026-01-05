<script lang="ts">
	import { productName, productVersion, buildDate, commitHash } from '../../scripts/app.ts';
	import Dialog from '../Dialog/Dialog.svelte';
	import ButtonGroup from '../Buttons/ButtonGroup.svelte';
	import Button from '../Buttons/ButtonNormal.svelte';
	interface Props {
		onBack?: () => void;
	}
	let { onBack: onBack }: Props = $props();

	function openUrl(url: string) {
		window.open(url, '_blank');
	}
</script>

<style>
	.title {
		font-size: 1.8vw;
		font-weight: bold;
		color: #fd1;
	}

	.build {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vw;
		font-size: 1vw;
		color: #aaa;
	}

	.build .row {
		display: flex;
		gap: 0.5vw;
	}

	.build .row .label {
		color: #888;
	}

	.build .row .value {
		color: #fff;
	}

	.links {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vw;
		margin-top: 1vw;
	}

	.buttons {
		margin-top: 1vw;
	}
</style>

<Dialog>
	<div class="title">{productName}</div>
	<div class="build">
		<div class="row">
			<span class="label">Version:</span>
			<span class="value">{productVersion}</span>
		</div>
		<div class="row">
			<span class="label">Build date:</span>
			<span class="value">{buildDate}</span>
		</div>
		<div class="row">
			<span class="label">Commit:</span>
			<span class="value">{commitHash}</span>
		</div>
	</div>
	<div class="links">
		<ButtonGroup areaID="about" initialIndex={2} {onBack}>
			<Button label="GitHub page" padding="0.5vw" fontSize="0.7vw" borderRadius="0.5vw" onConfirm={() => openUrl('https://github.com/libersoft-org/libershare')} />
			<Button label="Official website" padding="0.5vw" fontSize="0.7vw" borderRadius="0.5vw" onConfirm={() => openUrl('https://libershare.com')} />
			<Button label="OK" onConfirm={onBack} />
		</ButtonGroup>
	</div>
</Dialog>
