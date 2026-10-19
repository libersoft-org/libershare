import { type Networks } from '../lishnet/lishnets.ts';
import { type ApproveOptions, type CreateOverlayNetwork } from '../overlay/overlay-access.ts';
import { Utils } from '../utils.ts';
import { type LISHNetworkConfig, type OverlayAccessRequest, type OverlayCertificateBundle, type OverlayMember, type OverlayPendingRequest, type OverlayStatus } from '@shared';

const assert = Utils.assertParams;

export interface OverlayHandlers {
	create: (p: CreateOverlayNetwork) => Promise<LISHNetworkConfig>;
	requestAccess: (p: { networkID: string; name: string; infraAddr?: string }) => Promise<OverlayAccessRequest>;
	importRequest: (p: { request: unknown }) => Promise<OverlayPendingRequest>;
	listRequests: (p: { networkID: string }) => Promise<OverlayPendingRequest[]>;
	rejectRequest: (p: { networkID: string; requestID: string }) => Promise<boolean>;
	approve: (p: { networkID: string; requestID: string } & ApproveOptions) => Promise<OverlayCertificateBundle>;
	issue: (p: { request: unknown } & ApproveOptions) => Promise<OverlayCertificateBundle>;
	listMembers: (p: { networkID: string }) => Promise<OverlayMember[]>;
	revoke: (p: { networkID: string; fingerprint: string }) => Promise<{ success: true }>;
	setHosts: (p: { networkID: string; lighthouses: unknown; relays: unknown }) => Promise<{ success: true }>;
	importCertificate: (p: { certificate: unknown }) => Promise<OverlayStatus>;
	exportCA: (p: { networkID: string; forDevice?: boolean }) => Promise<{ networkID: string; caKey: string }>;
	importCA: (p: { networkID: string; caKey: string }) => Promise<{ success: true }>;
	status: (p: { networkID: string }) => Promise<OverlayStatus>;
	createInvite: (p: { networkID: string; validDays?: number }) => Promise<{ invite: string }>;
	useInvite: (p: { invite: string; name: string; infraAddr?: string }) => Promise<OverlayStatus>;
}

/**
 * Protected lishnets over the API. The same calls serve the UI and any external service holding the API token:
 * a membership portal can take a member's request, decide (payment, invitation code, anything) and call
 * `overlay.issue`, listening to `overlay:request` events for requests imported elsewhere.
 */
export function initOverlayHandlers(networks: Networks): OverlayHandlers {
	const access = networks.overlay;
	const roles = (p: ApproveOptions): ApproveOptions => ({ ...(p.validUntil !== undefined ? { validUntil: p.validUntil } : {}), ...(p.roles !== undefined ? { roles: p.roles } : {}) });
	return {
		create: p => {
			assert(p, ['name']);
			return access.create(p);
		},
		requestAccess: p => {
			assert(p, ['networkID', 'name']);
			return access.requestAccess(p.networkID, p.name, p.infraAddr);
		},
		importRequest: p => {
			assert(p, ['request']);
			return access.importRequest(p.request);
		},
		listRequests: p => {
			assert(p, ['networkID']);
			return access.listRequests(p.networkID);
		},
		rejectRequest: p => {
			assert(p, ['networkID', 'requestID']);
			return access.rejectRequest(p.networkID, p.requestID);
		},
		approve: p => {
			assert(p, ['networkID', 'requestID']);
			return access.approve(p.networkID, p.requestID, roles(p));
		},
		issue: p => {
			assert(p, ['request']);
			return access.issue(p.request, roles(p));
		},
		listMembers: p => {
			assert(p, ['networkID']);
			return access.listMembers(p.networkID);
		},
		revoke: async p => {
			assert(p, ['networkID', 'fingerprint']);
			await access.revoke(p.networkID, p.fingerprint);
			return { success: true };
		},
		setHosts: async p => {
			assert(p, ['networkID', 'lighthouses', 'relays']);
			await access.setHosts(p.networkID, p.lighthouses, p.relays);
			return { success: true };
		},
		importCertificate: p => {
			assert(p, ['certificate']);
			return access.importCertificate(p.certificate);
		},
		exportCA: p => {
			assert(p, ['networkID']);
			return access.exportCA(p.networkID, p.forDevice === true);
		},
		importCA: async p => {
			assert(p, ['networkID', 'caKey']);
			await access.importCA(p.networkID, p.caKey);
			return { success: true };
		},
		status: p => {
			assert(p, ['networkID']);
			return access.status(p.networkID);
		},
		createInvite: async p => {
			assert(p, ['networkID']);
			return { invite: await access.createInvite(p.networkID, p.validDays) };
		},
		useInvite: p => {
			assert(p, ['invite', 'name']);
			return access.useInvite(p.invite, p.name, p.infraAddr);
		},
	};
}
