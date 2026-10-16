# LISH network structure format specification

**Created**: 29 October 2025
**Last update**: 16 October 2026

## Overview

LISH network structure format describes a single LISH file sharing network. This format defines the network identity, connection parameters, and metadata needed to discover and join a specific LISH network. Network definitions can be shared by users to join networks.

## Features

- Network identification with unique UUID
- Human-readable network name and description
- Bootstrap peer configuration for network discovery
- Support for multiple bootstrap peers
- Creation timestamp
- Support for IPv4, IPv6, and DNS-based multiaddrs
- Optional overlay definition for protected networks

## Representation

LISH network structure format defines a data structure that can be used in various forms:

- As objects in memory during runtime
- Serialized to JSON format for interchange and storage
- Stored in files (commonly with `.lishnet` extension when using JSON)
- Stored in databases or other persistent storage systems

This specification describes the logical structure, with JSON examples for clarity.

## Structure

```typescript
interface ILISHNetwork {
	networkID: string; // Unique UUID for this network (required)
	name: string; // Network name (required)
	description?: string; // Free-form text description such as purpose, rules, etc. (optional)
	bootstrapPeers: string[]; // Array of bootstrap peer multiaddrs for network discovery (required)
	created?: string; // ISO 8601 timestamp in UTC when network was created (optional)
	overlay?: ILISHOverlay; // Present for a protected network (optional)
}
```

## Protected networks

A network with an `overlay` runs inside its own [Nebula](https://github.com/slackhq/nebula) overlay instead of on the public node. Members reach each other only under overlay addresses; their public addresses are known only to the network's own lighthouses and relays. Joining needs a certificate signed by the network's certificate authority (CA), whose key stays with the founder. The overlay object is public: it holds no key and no secret.

```typescript
interface ILISHOverlay {
	type: 'nebula'; // Overlay technology (required)
	caCert: string; // PEM certificate of the network's CA (required)
	subnet: string; // IPv4 subnet of overlay addresses, aligned, /8 to /30, e.g. "100.64.0.0/16" (required)
	lighthouses: IOverlayHost[]; // Hosts members find each other through (required, may be empty while the founder sets them up)
	relays: IOverlayHost[]; // Hosts that carry traffic between members (required, may be empty likewise)
	lanDirect?: boolean; // Members behind the same public address connect directly (default false)
	version?: number; // Version of the signed network state the hosts come from (default 0)
}

interface IOverlayHost {
	vpnIP: string; // Overlay address inside subnet (required)
	addr: string; // Public UDP endpoint, host:port (required)
	peerID?: string; // libp2p peer ID of the host's node in this network, which makes it a bootstrap peer (optional)
}
```

The bootstrap peers of a protected network are overlay addresses (`/ip4/<overlay address>/tcp/9090/p2p/<peer ID>`). Lighthouses and relays can change after the definition was shared: the founder publishes a newer state signed by the CA key (see LISH_NETWORK_PROTOCOL.md), and members update their copy from it.

## Bootstrap peers

Bootstrap peers are initial connection points for discovering other peers in the network. They are specified as [**libp2p multiaddrs**](https://docs.libp2p.io/concepts/fundamentals/addressing/).

**Multiaddr format examples**:

- `/ip4/192.168.0.10/tcp/9090/p2p/QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N`
- `/dns4/bootstrap.example.com/tcp/7070/p2p/QmU3vQnXwYp7zRfKjLmN9BcDeTpRsWxYvZqNmLkJhGfTxP`
- `/ip6/fd00::1/tcp/5050/p2p/QmV9wRyYzP8bNcMjDkLqTnWsXvZpRmLkJhGfTxPuOnXwYq`

## Example

### Minimal network

```json
{
	"networkID": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
	"name": "Public LISH Network",
	"bootstrapPeers": ["/ip4/192.168.1.10/tcp/9090/p2p/QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"]
}
```

### Full-featured network

```json
{
	"networkID": "a3f8c2e1-9b7d-4f2a-8c5e-1a2b3c4d5e6f",
	"name": "Research Lab Network",
	"description": "Private network for research collaboration",
	"bootstrapPeers": ["/ip4/192.168.0.10/tcp/9090/p2p/QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N", "/dns4/bootstrap.example.com/tcp/7070/p2p/QmU3vQnXwYp7zRfKjLmN9BcDeTpRsWxYvZqNmLkJhGfTxP", "/ip6/fd00::1/tcp/5050/p2p/QmV9wRyYzP8bNcMjDkLqTnWsXvZpRmLkJhGfTxPuOnXwYq"],
	"created": "2025-10-20T14:30:00.000Z"
}
```

## Notes

- At least one bootstrap peer must be provided
- All timestamps must use ISO 8601 format in UTC timezone (e.g., "2025-10-20T14:30:00.000Z")
- A protected network keeps its CA: importing a definition with the same `networkID` and a different `caCert` is refused


