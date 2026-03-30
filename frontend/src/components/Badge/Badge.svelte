<script lang="ts">
	import { type DownloadStatus } from '../../scripts/downloads.ts';
	interface Props {
		label?: string;
		status?: DownloadStatus | undefined;
	}
	let { label = '', status = undefined }: Props = $props();
</script>

<style>
	.badge {
		display: inline-block;
		text-align: center;
		padding: 0.3vh 0.8vh;
		border: 0.2vh solid var(--badge-fg, var(--disabled-foreground));
		border-radius: 0.5vh;
		background-color: var(--badge-bg, var(--disabled-background));
		color: var(--badge-fg, var(--disabled-foreground));
		font-size: inherit;
		white-space: nowrap;
	}

	.badge.idling {
		--badge-fg: var(--status-idling-fg);
		--badge-bg: var(--status-idling-bg);
	}

	.badge.downloading {
		--badge-fg: var(--status-downloading-fg);
		--badge-bg: var(--status-downloading-bg);
	}

	.badge.uploading {
		--badge-fg: var(--status-uploading-fg);
		--badge-bg: var(--status-uploading-bg);
	}

	.badge.downloading-uploading {
		--badge-fg: var(--status-downloading-uploading-fg);
		--badge-bg: var(--status-downloading-uploading-bg);
	}

	.badge.verifying {
		--badge-fg: var(--status-verifying-fg);
		--badge-bg: var(--status-verifying-bg);
	}

	.badge.pending-verification {
		--badge-fg: var(--status-pending-verification-fg);
		--badge-bg: var(--status-pending-verification-bg);
	}

	.badge.moving {
		--badge-fg: var(--status-moving-fg);
		--badge-bg: var(--status-moving-bg);
	}

	.badge.allocating {
		--badge-fg: var(--status-verifying-fg);
		--badge-bg: var(--status-verifying-bg);
	}
</style>

<div class="badge" class:idling={status === 'idling'} class:downloading={status === 'downloading'} class:uploading={status === 'uploading'} class:downloading-uploading={status === 'downloading-uploading'} class:verifying={status === 'verifying'} class:pending-verification={status === 'pending-verification'} class:moving={status === 'moving'} class:allocating={status === 'allocating'}>{label}</div>
