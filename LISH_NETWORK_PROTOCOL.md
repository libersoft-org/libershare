# LISH Network protocol specification

**Version**: 1  
**Created**: 24 October 2025
**Last update**: 26 October 2025

## Overview

The LISH protocol is a peer-to-peer communication protocol for file sharing. It enables decentralized, verifiable, and resumable file transfers with multi-source parallel downloading capabilities.

## Architecture

### Core components

- **Transport layer**: [**libp2p**](https://en.wikipedia.org/wiki/Libp2p) for peer-to-peer networking
- **Connection**: WebRTC for direct P2P connections with NAT traversal
- **Data structure**: [**LISH data format structure**](./LISH_DATA_FORMAT.md) for directory structure, permissions and integrity verification metadata

### Network topology

The protocol uses a **DHT** for peer discovery, allowing peers to find each other without centralized servers. The DHT implementation is built on top of **libp2p's Kademlia DHT**.

## Network structures

### Network configuration

Defines a peer to peer network with access control rules.

```typescript
interface INetworkConfig {
	networkID: string; // Network UUID (required)
	name?: string; // Network name (optional)
	description?: string; // Network description (optional)
	created?: string; // ISO 8601 timestamp (optional)
}
```

### Network access control

Defines who can perform actions within a network.

**Access levels**:

- **Owners**: Can edit network configuration, add / remove admins, publishers, and downloaders
- **Admins**: Can add / remove publishers and downloaders
- **Publishers**: Can publish new data to the network
- **Downloaders**: Can download content from uploaders (not just from publishers)

```typescript
interface INetworkAccess {
	owners: string[]; // Owner peer IDs
	admins: string[]; // Admin peer IDs
	publishers: string[]; // Publisher peer IDs
	downloaders: string[]; // Downloader peer IDs
	restrictPublishers?: boolean; // Publishing restrictions (optional, default: false), true = only publishers can publish new data, false / undefined = anyone can publish
	restrictDownloaders?: boolean; // Download restrictions (optional, default: false), true = only downloaders can download, false / undefined = anyone can download
}
```

### Network database

Stores a decentralized database of LISH data shared in network.

```typescript
interface ILISHDatabase {
	data: ILISHEntry[]; // Array of LISH data entries
}
```

```typescript
interface ILISHEntry {
	lish: ILISHData; // LISH data structure
	publisher?: string; // PeerID who published the LISH data (optional if not required by network)
	published?: string; // ISO 8601 timestamp when published to network (optional if not required by network)
}
```

**Note**: LISH data themselves do NOT contain `networkID`. The same LISH data can be shared on multiple networks.

## Message types

All messages are JSON-encoded and transmitted over libp2p streams.

### 1. PUBLISH_MANIFEST

Publishes data represented in LISH data format to the network.

```typescript
{
 type: 'publish_lish_data',
 lish: ILISHData, // LISH data format
}
```

**Usage**: Broadcast to DHT

### 2. REQUEST_DATA

Requests the full LISH data in LISH Data Format.

```typescript
{
 type: 'request_lish_data',
 lishID: string,
 requestID: string // Unique ID for tracking this request
}
```

**Response**: `DATA` or `ERROR`

### 3. DATA

Delivers the LISH data in LISH data format to a requesting peer.

```typescript
{
 type: 'data',
 requestID: string, // Matches REQUEST_MANIFEST.requestID
 data: ILISH        // Complete LISH object
}
```

**Verification**: Receiver must verify `LISHHash` matches SHA-256 of received LISH data.

### 4. REQUEST_CHUNKS

Requests specific file chunks.

```typescript
{
 type: 'request_chunks',
 lishID: string,
 filePath: string,      // Relative path from LISH data
 chunkIDs: number[],    // Array of chunk indices (0-based)
 requestID: string
}
```

### 5. CHUNK_DATA

Delivers chunk data.

```typescript
{
 type: 'chunk_data',
 requestID: string,
 data: Uint8Array   // Binary chunk data (base64 in JSON transport)
}
```

**Behavior**:

- If checksum does not match with chunk data, receiver should request chunk again from different peer

### 6. GET_NETWORK_CONFIG

Delivers network configuration. For owners only

```typescript
{
 type: 'get_network_config',
 requestID: string,
}
```

### 7. SET_NETWORK_CONFIG

Updates network configuration (owners only).

```typescript
{
 type: 'set_network_config',
 sets: Partial<INetworkConfig>
}
```

### 8. MANAGE_MEMBERS

Manages network members (owners and admins).

```typescript
{
 type: 'manage_members',
 networkID: string,
 action: 'add' | 'remove',
 role: 'admin' | 'publisher' | 'downloader',
 peerIDs: string[]
}
```

**Authorization**:

- Owners can manage all roles
- Admins can manage publishers and downloaders only

### 9. REMOVE_MANIFEST

Removes a lish data from the network. Can be done by owners or admins only

```typescript
{
 type: 'remove_data',
 lishID: string
}
```

## TODO

- **Compression**: Optional chunk compression (zstd, brotli, ...)
- **Incentives**: Token-based upload/download credits
- **Smart routing**: Route through fastest paths automatically
- **Private networks**: Networks that hide data availability unless specific conditions are met (authentication, payment, etc.)
