import { wsClient } from './ws-client';

export const api = {
    // Raw call access
    call: wsClient.call.bind(wsClient),
    on: wsClient.on.bind(wsClient),
    off: wsClient.off.bind(wsClient),

    // Stats
    getStats: () =>
        wsClient.call<{
            networks: { total: number; enabled: number; connected: number };
            peers: number;
            datasets: { total: number; complete: number; downloading: number };
            space: any;
            transfers: {
                download: { now: number; total: number };
                upload: { now: number; total: number };
            };
        }>('getStats'),

    // Networks
    listNetworks: () =>
        wsClient.call<any[]>('networks.list'),

    getNetwork: (networkId: string) =>
        wsClient.call<any>('networks.get', { networkId }),

    importNetworkFromFile: (path: string, enabled = false) =>
        wsClient.call<any>('networks.importFromFile', { path, enabled }),

    importNetworkFromJson: (json: any, enabled = false) =>
        wsClient.call<any>('networks.importFromJson', { json, enabled }),

    setNetworkEnabled: (networkId: string, enabled: boolean) =>
        wsClient.call<{ success: boolean }>('networks.setEnabled', { networkId, enabled }),

    deleteNetwork: (networkId: string) =>
        wsClient.call<{ success: boolean }>('networks.delete', { networkId }),

    connectToPeer: (networkId: string, multiaddr: string) =>
        wsClient.call<{ success: boolean }>('networks.connect', { networkId, multiaddr }),

    findPeer: (networkId: string, peerId: string) =>
        wsClient.call<any>('networks.findPeer', { networkId, peerId }),

    getNetworkAddresses: (networkId: string) =>
        wsClient.call<string[]>('networks.getAddresses', { networkId }),

    getNetworkPeers: (networkId: string) =>
        wsClient.call<string[]>('networks.getPeers', { networkId }),

    getNetworkNodeInfo: (networkId: string) =>
        wsClient.call<{ peerId: string; addresses: string[] }>('networks.getNodeInfo', { networkId }),

    getNetworkStatus: (networkId: string) =>
        wsClient.call<{
            connected: number;
            connectedPeers: string[];
            peersInStore: number;
            datasets: number;
        }>('networks.getStatus', { networkId }),

    // Manifests
    getAllManifests: () =>
        wsClient.call<any[]>('getAllManifests'),

    getManifest: (lishId: string) =>
        wsClient.call<any>('getManifest', { lishId }),

    // Datasets
    getDatasets: () =>
        wsClient.call<any[]>('getDatasets'),

    getDataset: (id: string) =>
        wsClient.call<any>('getDataset', { id }),

    // High-level operations
    createLish: (path: string) =>
        wsClient.call<{ manifestId: string }>('createLish', { path }),

    download: (networkId: string, manifestPath: string) =>
        wsClient.call<{ downloadDir: string }>('download', { networkId, manifestPath }),

    fetchUrl: (url: string) =>
        wsClient.call<{ url: string; status: number; contentType: string | null; content: string }>('fetchUrl', { url }),

    // Filesystem
    fsInfo: () =>
        wsClient.call<{
            platform: 'windows' | 'linux' | 'darwin';
            separator: string;
            home: string;
            roots: string[];
        }>('fs.info'),

    fsList: (path?: string) =>
        wsClient.call<{
            path: string;
            entries: Array<{
                name: string;
                path: string;
                type: 'file' | 'directory' | 'drive';
                size?: number;
                modified?: string;
                hidden?: boolean;
            }>;
        }>('fs.list', { path }),
};