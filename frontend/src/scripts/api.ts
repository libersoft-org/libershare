import { wsClient } from './ws-client';
import type {
    NetworkDefinition,
    NetworkStatus,
    NetworkNodeInfo,
    Stats,
    Dataset,
    FsInfo,
    FsListResult,
    SuccessResponse,
    CreateLishResponse,
    DownloadResponse,
    FetchUrlResponse,
} from '@libershare/shared';

export const api = {
    // Raw call access
    call: wsClient.call.bind(wsClient),
    on: wsClient.on.bind(wsClient),
    off: wsClient.off.bind(wsClient),

    // Stats
    getStats: () => wsClient.call<Stats>('getStats'),

    // Networks
    listNetworks: () => wsClient.call<NetworkDefinition[]>('networks.list'),

    getNetwork: (networkId: string) => wsClient.call<NetworkDefinition>('networks.get', { networkId }),

    importNetworkFromFile: (path: string, enabled = false) =>
        wsClient.call<NetworkDefinition>('networks.importFromFile', { path, enabled }),

    importNetworkFromJson: (json: string, enabled = false) =>
        wsClient.call<NetworkDefinition>('networks.importFromJson', { json, enabled }),

    setNetworkEnabled: (networkId: string, enabled: boolean) =>
        wsClient.call<SuccessResponse>('networks.setEnabled', { networkId, enabled }),

    deleteNetwork: (networkId: string) =>
        wsClient.call<SuccessResponse>('networks.delete', { networkId }),

    connectToPeer: (networkId: string, multiaddr: string) =>
        wsClient.call<SuccessResponse>('networks.connect', { networkId, multiaddr }),

    findPeer: (networkId: string, peerId: string) =>
        wsClient.call<any>('networks.findPeer', { networkId, peerId }),

    getNetworkAddresses: (networkId: string) =>
        wsClient.call<string[]>('networks.getAddresses', { networkId }),

    getNetworkPeers: (networkId: string) =>
        wsClient.call<string[]>('networks.getPeers', { networkId }),

    getNetworkNodeInfo: (networkId: string) =>
        wsClient.call<NetworkNodeInfo>('networks.getNodeInfo', { networkId }),

    getNetworkStatus: (networkId: string) =>
        wsClient.call<NetworkStatus>('networks.getStatus', { networkId }),

    // Manifests
    getAllManifests: () => wsClient.call<any[]>('getAllManifests'),

    getManifest: (lishId: string) => wsClient.call<any>('getManifest', { lishId }),

    // Datasets
    getDatasets: () => wsClient.call<Dataset[]>('getDatasets'),

    getDataset: (id: string) => wsClient.call<Dataset>('getDataset', { id }),

    // High-level operations
    createLish: (path: string) => wsClient.call<CreateLishResponse>('createLish', { path }),

    download: (networkId: string, manifestPath: string) =>
        wsClient.call<DownloadResponse>('download', { networkId, manifestPath }),

    fetchUrl: (url: string) => wsClient.call<FetchUrlResponse>('fetchUrl', { url }),

    // Filesystem
    fsInfo: () => wsClient.call<FsInfo>('fs.info'),

    fsList: (path?: string) => wsClient.call<FsListResult>('fs.list', { path }),
};