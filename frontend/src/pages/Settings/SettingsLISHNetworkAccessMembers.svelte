<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkConfig, type OverlayMember } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();

	let members = $state<OverlayMember[]>([]);
	let revoking = $state<OverlayMember | null>(null);

	async function load(): Promise<void> {
		try {
			members = await api.overlay.listMembers(network.networkID);
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const confirmPage = createSubPage(navHandle, () => areaID);

	function askRevoke(member: OverlayMember): void {
		if (member.revoked || member.founder) return;
		revoking = member;
		confirmPage.enter(`${member.name} - ${$t('settings.lishNetwork.protected.revoke')}`, () => void closeConfirm());
	}

	async function closeConfirm(): Promise<void> {
		revoking = null;
		await confirmPage.exit();
	}

	async function revoke(): Promise<void> {
		const member = revoking;
		if (!member) return;
		try {
			await api.overlay.revoke(network.networkID, member.fingerprint);
			addNotification(tt('settings.lishNetwork.protected.revokedDone', { name: member.name }), 'warning');
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
		await closeConfirm();
		await load();
	}

	function roles(member: OverlayMember): string {
		const names = member.roles.map(r => $t(`settings.lishNetwork.protected.${r}`));
		if (member.founder) names.unshift($t('settings.lishNetwork.protected.roleFounder'));
		return names.join(', ') || '—';
	}

	const offs: Array<(() => void) | void> = [];
	onMount(() => {
		void load();
		api.subscribe('overlay:members').catch(() => {});
		offs.push(api.on('overlay:members', (data: { networkID?: string }) => data?.networkID === network.networkID && void load()));
	});
	onDestroy(() => {
		for (const off of offs) off?.();
		api.unsubscribe('overlay:members').catch(() => {});
	});
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 1200px;
		max-width: 100%;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 1.8vh;
	}

	.revoked {
		color: var(--color-error);
		font-weight: bold;
	}
</style>

{#if confirmPage.active && revoking}
	<ConfirmDialog title={$t('settings.lishNetwork.protected.revoke')} message={tt('settings.lishNetwork.protected.confirmRevoke', { name: revoking.name })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={revoke} onBack={() => void closeConfirm()} />
{:else}
	<div class="page" data-testid="overlay-members-{network.networkID}">
		<div class="container">
			{#if members.length === 0}
				<Alert type="info" message={$t('settings.lishNetwork.protected.noMembers')} />
			{:else}
				<Table columns="1fr 16vh 22vh 1fr 14vh" columnsMobile="1fr 1fr">
					<TableHeader>
						<TableCell>{$t('settings.lishNetwork.protected.colName')}</TableCell>
						<TableCell>{$t('settings.lishNetwork.protected.colAddress')}</TableCell>
						<TableCell>{$t('settings.lishNetwork.protected.colValidUntil')}</TableCell>
						<TableCell>{$t('settings.lishNetwork.protected.colRoles')}</TableCell>
						<TableCell>·</TableCell>
					</TableHeader>
					{#each members as member, i (member.fingerprint)}
						<TableRow position={[0, i]} dimmed={member.revoked} onConfirm={() => askRevoke(member)}>
							<TableCell>{member.name}</TableCell>
							<TableCell><span class="mono">{member.vpnIP}</span></TableCell>
							<TableCell>{new Date(member.notAfter).toLocaleDateString()}</TableCell>
							<TableCell>{roles(member)}</TableCell>
							<TableCell>
								{#if member.revoked}<span class="revoked">{$t('settings.lishNetwork.protected.revokedBadge')}</span>{:else if !member.founder}{$t('settings.lishNetwork.protected.revoke')}{/if}
							</TableCell>
						</TableRow>
					{/each}
				</Table>
			{/if}
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, members.length]} onConfirm={onBack} />
		</div>
	</div>
{/if}
