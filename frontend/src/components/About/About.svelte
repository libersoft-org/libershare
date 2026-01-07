<script lang="ts">
	import { productName, productVersion, buildDate, commitHash } from '../../scripts/app.ts';
	import Dialog from '../Dialog/Dialog.svelte';
	import ButtonGroup from '../Buttons/ButtonGroup.svelte';
	import Button from '../Buttons/Button.svelte';
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
		font-size: 2.5vh;
		font-weight: bold;
		color: #fd1;
	}

	.build {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1vh;
		font-size: 2vh;
		color: #aaa;
	}

	.build .row {
		display: flex;
		gap: 1vh;
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
		gap: 1vh;
		margin-top: 2vh;
	}

	.buttons {
		margin-top: 2vh;
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
			<Button label="GitHub page" padding="1vh" fontSize="1.4vh" borderRadius="1vh" onConfirm={() => openUrl('https://github.com/libersoft-org/libershare')} />
			<Button label="Official website" padding="1vh" fontSize="1.4vh" borderRadius="1vh" onConfirm={() => openUrl('https://libershare.com')} />
			<Button label="OK" onConfirm={onBack} />
		</ButtonGroup>
	</div>
</Dialog>
