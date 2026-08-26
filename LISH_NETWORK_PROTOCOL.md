# LISH Network protocol specification

- **Document version**: 1
- **Protocol**: `/lish/0.0.1`
- **Created**: 24 October 2025
- **Last update**: 26 August 2026

## Overview

The LISH network protocol is a peer-to-peer communication protocol for sharing content described by the [**LISH data structure format**](./LISH_DATA_FORMAT.md). It enables decentralized, verifiable, and resumable file transfers with multi-source parallel downloading.

The protocol has two planes:

- **Control plane** — small broadcast messages exchanged over gossipsub topics (one topic per network), JSON-encoded
- **Data plane** — request / response messages exchanged over direct libp2p streams using the `/lish/0.0.1` protocol, MessagePack-encoded

## Architecture

### Transport stack

The protocol is built on [**libp2p**](https://libp2p.io/):

| Layer               | Implementation                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Transport           | TCP, Circuit Relay v2 (for peers behind NAT)                                                           |
| Encryption          | Noise                                                                                                  |
| Stream multiplexing | Yamux                                                                                                  |
| Broadcast messaging | gossipsub (with Peer Exchange)                                                                         |
| NAT traversal       | AutoNAT v2 (reachability detection), DCUtR (hole punching), optional UPnP port mapping, relay fallback |
| Peer metadata       | Identify / Identify Push, Ping                                                                         |

Peers with a public address may additionally run a **circuit relay server** and forward traffic for NAT'd peers that cannot be reached directly.

### Networks and topics

A **network** (lishnet) is defined by the [**LISH network structure format**](./LISH_NETWORK_FORMAT.md) — a network UUID, a name, and a list of bootstrap peer multiaddrs. Joining a network means subscribing to its gossipsub topic:

```
lish/<networkID>
```

The subscribers of a network's topic are the network's participants. One node can join any number of networks. LISH data themselves do NOT contain a `networkID`.

The reference implementation currently has no per-LISH network assignment. Upload enablement is global: a peer that shares any joined lishnet with this node can discover and request every upload-enabled LISH. A lishnet is therefore a peer-membership boundary, not an isolation boundary between individual shares. Per-LISH network scoping belongs to the planned access-control extension.

### Peer discovery

The protocol does not use a DHT. Peers are discovered through complementary mechanisms:

1. **Bootstrap peers** — dialed from the network definition when joining
2. **gossipsub Peer Exchange (PX)** — mesh maintenance propagates peer addresses on prune
3. **`peer-announce` gossip** — periodic broadcast of own and known same-network peer multiaddrs (see below)
4. **mDNS** — optional discovery of peers on the local network

## Control plane (gossipsub messages)

Control messages are JSON objects encoded as UTF-8, published on a network's `lish/<networkID>` topic. Every message MUST be signed with the sender's peer key (gossipsub `StrictSign` policy) — unsigned or invalidly signed messages are rejected. Receivers MUST drop payloads that exceed 256 KiB or fail to parse. The sender's peer ID is always taken from the validated gossipsub envelope, never from the payload — control messages carry no sender field that could be spoofed.

### want

Broadcast by a peer that wants to download a LISH. Every subscriber that shares the LISH replies with a unicast `announceHave` on the data plane.

```typescript
{
	type: 'want',
	lishID: string // LISH UUID
}
```

**Receiver behavior**:

- Ignore when the LISH is not shared (upload disabled), temporarily busy (verification or data move in progress), or its data directory is missing on disk
- Ignore when the responder has no verified chunks of the LISH yet (nothing to serve)
- After an `announceHave` is sent successfully, start a 60-second cooldown for that (peer, lishID) pair. Requests that arrive concurrently before the first send completes are not coalesced

### searchLishs

Broadcast by a peer searching the network for content. Peers whose shared LISHs match reply with a unicast `searchResult` on the data plane.

```typescript
{
	type: 'searchLishs',
	searchID: string, // Unique ID for pairing responses to this query
	query: string     // Case-insensitive substring, matched against LISH ID and name
}
```

**Receiver behavior**:

- Drop empty queries and queries longer than 256 characters
- Deduplicate by `searchID` — the same query can arrive via several gossipsub mesh paths, answer at most once (the reference implementation remembers seen IDs for 5 minutes)
- Match only upload-enabled LISHs that are not busy. As with `getLishs`, a search result does not prove that the data directory exists or that the peer still has a verified chunk
- No matching LISH → no response (the searcher treats silence as "no result")

### peer-announce

Periodic peer-discovery broadcast. Contains the sender's own directly dialable multiaddrs plus, transitively, the multiaddrs of peers recently seen subscribed to the same topic. Circuit-relay addresses are not propagated by this message. The transitive list is scoped to the topic's own subscribers, so peers of one network are never advertised into another.

```typescript
{
	type: 'peer-announce',
	multiaddrs: string[] // Multiaddrs including the /p2p/<peerID> suffix
}
```

**Sender behavior**:

- The announce interval adapts to peer-store size: 15 seconds below 20 peers, 30 seconds from 20 through 79 peers, and 180 seconds at 80 peers or more, each with ±25% random jitter. The reference implementation starts broadcasting once its peer store contains at least five peers
- The reference implementation sends at most 32 self addresses, three addresses per transitive peer, and 128 addresses in total
- Loopback and non-routable private addresses are filtered out before sending

**Receiver behavior**:

- Drop unparseable, loopback, non-local private, anonymous (no trailing `/p2p/<peerID>`), or overlong addresses — every receiver must filter defensively regardless of sender-side filtering
- Bound intake before dialing. The reference implementation has a 1,024-entry hard walk cap, accepts at most 128 unique addresses per message, limits each address to 512 characters, and applies per-announcing-peer token buckets to both raw parsing work and admitted addresses (384-entry initial burst, refilling at 256 entries per minute). Both bucket maps use a 1,024-source LRU cap
- Treat every announced address as an unverified claim. The reference implementation dials it but does not persist or keep-alive-tag the peer until a successful Noise-authenticated connection proves the identity
- A cryptographically proven identity mismatch (the Noise handshake reports a different peer ID than the address claims) is definitive — the receiver purges the announced entry so the dead identity is not re-dialed or re-gossiped

## Data plane (`/lish/0.0.1` stream protocol)

Request / response messages over a libp2p stream. Every message is a MessagePack-encoded object framed with an unsigned-varint length prefix. A single stream can carry any number of requests; the responder answers each request with exactly one response, in order. Binary chunk data uses the MessagePack native binary type — no base64 overhead.

Message size is bounded by the receiving peer's configured maximum message size (reference implementation default: 128 MiB). It must cover the largest chunk plus encoding overhead, and manifests of many-file LISHs. The current implementation applies the same cap to small inbound requests and large responses; see Security properties and current limitations.

Requests are discriminated by a `type` field. Undecodable MessagePack, a non-object payload, or an unknown request type is answered with `PEER_INVALID_REQUEST`, and the stream stays open for further messages. Version 0.0.1 does not apply one uniform runtime schema to the required fields of every known request type; operation-specific validation is described below.

The stream's remote peer ID is authenticated by libp2p. The reference implementation serves manifests and chunks only while the remote peer shares at least one currently joined lishnet with this node; a denial is indistinguishable from an unshared LISH. The lower-sensitivity `getLishs` listing additionally allows a non-infrastructure peer during the first 30 seconds of a new connection while gossipsub subscription state propagates.

Responders SHOULD answer promptly: the reference implementation treats a peer that does not respond within 15 seconds (list requests, acknowledgements) or 30 seconds (manifest and chunk requests) as unreachable and moves on.

### getLishs — list shared LISHs

Requests the list of LISHs the peer currently shares.

```typescript
// Request
{
	type: 'getLishs',
	query?: string // Optional case-insensitive substring filter on LISH ID and name
}

// Response
{
	type: 'getLishs-result',
	lishs: Array<{
		id: string,        // LISH UUID
		name?: string,     // LISH name, if set
		totalSize?: number // Total size of all files in bytes
	}>
}
// or
{ type: 'getLishs-result', error: string }
```

**Behavior**:

- Upload-enabled LISHs that are not busy are listed, newest first. Listing does not prove that the data directory still exists or that the peer has a verified chunk; the subsequent `want`, manifest, and chunk paths apply their own checks
- With `query`, the responder applies the same case-insensitive substring filter as `searchLishs` — this is the unicast fallback used to search freshly discovered peers that are not yet visible in the gossipsub subscriber set
- A peer outside the shared-lishnet or 30-second propagation window receives an empty list

### getLish — fetch manifest

Requests the full manifest (LISH data format structure) of a single LISH.

```typescript
// Request
{
	type: 'getLish',
	lishID: string
}

// Response
{ manifest: ILISH } // LISH data format structure (see LISH_DATA_FORMAT.md)
// or
{ error: string }
```

**Behavior**:

- The manifest contains the complete LISH data format structure — directory tree, file list, chunk checksums — and MUST NOT include responder-local state (local paths, per-chunk possession)
- A LISH that is not shared is answered with `PEER_LISH_NOT_SHARED`; a LISH the peer does not have at all is answered with the same code, so possession is not revealed
- A temporarily busy LISH (verification, data move, or deletion in progress) is likewise answered with `PEER_LISH_NOT_SHARED` — `PEER_BUSY` is only used for chunk requests
- The requester MUST check that the returned manifest's `id` equals the requested `lishID` — otherwise a peer could answer with a different LISH and have it stored under the requested id
- Every received manifest MUST pass structural validation before it is persisted or allocated. The reference implementation checks field types, supported checksum algorithms, non-negative integer file sizes, a positive integer `chunkSize` no larger than the configured limit (100 MiB by default), the exact checksum count `ceil(size / chunkSize)`, and consistent expected lengths for duplicate checksums
- The requester strips responder-local paths and per-chunk possession state at the trust boundary. These fields are never authoritative on the wire

### getChunk — fetch chunk data

Requests the binary data of one chunk.

```typescript
// Request
{
	type: 'getChunk', // May be omitted; a request without `type` is treated as getChunk
	lishID: string,
	chunkID: string // Chunk checksum from the manifest (a `files[].checksums[]` entry)
}

// Response
{ data: Uint8Array } // Raw binary chunk data (MessagePack binary type)
// or
{ error: string }
```

**Behavior**:

- Chunks are identified by their **checksum**, not by a positional index. Chunks with identical content therefore share one identifier — a single received chunk can satisfy every position (in any file) that lists the same checksum
- The requester MUST hash the received data with the manifest's `checksumAlgo` and compare the result to the requested `chunkID`; on mismatch it discards the data and re-queues the chunk (typically retried via another peer), banning peers that repeatedly deliver corrupt data (see Peer penalties)
- A LISH that is not shared (or that the peer does not have at all) is answered with `PEER_LISH_NOT_SHARED` — same non-revealing semantics as `getLish`
- A peer that has the LISH but not this chunk (partial seeder) answers `PEER_CHUNK_NOT_FOUND` — the requester goes elsewhere for that chunk
- A peer at its per-LISH upload capacity, or with the LISH temporarily busy (verification, data move, or deletion), answers `PEER_BUSY` — the requester retries later
- A peer that fails to read the chunk from disk answers `PEER_IO_ERROR`

### announceHave — availability announcement

Sent by a seeder in reply to a pubsub `want`, over a fresh stream to the requester.

```typescript
// Request
{
	type: 'announceHave',
	lishID: string,
	chunks: 'all' | string[], // Chunk checksums the seeder can serve ('all' = complete LISH)
	multiaddrs: string[]      // Seeder's dial addresses for the chunk-transfer connection
}

// Response
{ ok: true }
// or
{ error: string }
```

**Behavior**:

- The announcement itself is attributed to the verified stream remote peer ID, never to a payload field
- `multiaddrs` are untrusted dial hints. The current reference implementation does not yet bind the peer reached by the follow-up dial back to the announcer, so callers MUST NOT treat those addresses as authenticated by the announcement
- Partial seeders announce only the chunks they can serve; a downloader can therefore pull different chunks from different incomplete peers in parallel

### searchResult — search response

Sent by a peer in reply to a pubsub `searchLishs`, over a fresh stream to the searcher.

```typescript
// Request
{
	type: 'searchResult',
	searchID: string, // Matches searchLishs.searchID
	lishs: Array<{
		id: string,
		name?: string,
		totalSize?: number
	}>
}

// Response
{ ok: true }
// or
{ error: string }
```

**Behavior**:

- An empty `lishs` array is accepted by receivers as an explicit "no match" signal; the reference implementation sends no response at all instead of an empty result

### Error codes

Wire error codes returned in the `error` field:

| Code                   | Meaning                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PEER_INVALID_REQUEST` | Undecodable MessagePack, a non-object payload, or an unknown request type; known request types do not all enforce a uniform field schema |
| `PEER_LISH_NOT_SHARED` | The LISH is not shared by this peer (also returned when the peer does not have it — deliberately indistinguishable)                     |
| `PEER_CHUNK_NOT_FOUND` | The peer does not have the requested chunk (partial seeder)                                                                             |
| `PEER_BUSY`            | Transient rejection, returned for chunk requests only — verification, data move, deletion, or upload peer capacity reached; retry later |
| `PEER_IO_ERROR`        | The peer failed to read the requested data from disk                                                                                    |

## Transfer flow

1. **Join** — subscribe to `lish/<networkID>`, dial the network's bootstrap peers
2. **Want** — broadcast `want` with the LISH ID; while seeders are missing, the `want` may be re-broadcast periodically (receivers rate-limit their responses, see above)
3. **Have** — seeders reply with unicast `announceHave` (chunk availability + dial addresses)
4. **Manifest** — the downloader dials a seeder and fetches the manifest via `getLish` (skipped when it already has the structure, e.g. from an imported `.lish` file)
5. **Chunks** — the downloader requests chunks from multiple seeders in parallel via `getChunk`, verifying every chunk against its manifest checksum
6. **Resume** — verified chunks are persisted; a restarted download requests only the missing chunks
7. **Seed** — a peer can serve every chunk it has verified, even before its own download completes (partial seeding)

**Peer penalties** (downloader-side, reference implementation): a peer that repeatedly delivers corrupt chunks is banned for the lifetime of that downloader; recreating the transfer creates a fresh peer manager. A peer that repeatedly fails transiently (busy, I/O errors) is dropped into a temporary quarantine and retried after a few minutes — or immediately after it sends a fresh `announceHave`. A `PEER_CHUNK_NOT_FOUND` answer is not a failure: it is remembered per chunk (the peer is never asked for that chunk again) and keeps the partial seeder in rotation for the chunks it does have.

## Search flow

1. The searcher broadcasts `searchLishs` with a unique `searchID`
2. Matching peers reply with unicast `searchResult`
3. As a fallback, the searcher may also issue `getLishs` with the same query directly to its currently connected peers (including peers that connect while the search is still running) — this covers peers not yet propagated through the gossipsub subscriber set

## Security properties and current limitations

- Strictly signed gossipsub envelopes authenticate the sender of control messages. Noise authenticates the remote endpoint of a data-plane stream. Neither property signs the LISH manifest itself
- A LISH ID is a random UUID, not a content hash. Matching the requested ID, validating manifest structure, and hashing chunks proves internal consistency with the received manifest; it does not prove publisher authenticity. Version 0.0.1 uses the first accepted manifest for that UUID as its trust root
- The reference implementation accepts inbound request frames up to the same 128 MiB limit required for large responses before applying the per-request serving gate. Requests are normally small, but the protocol does not yet define a separate small request-frame cap
- Structural manifest validation does not cap total file count, checksum count, or declared logical size, and it is not a disk-quota preflight. A downloader must treat allocation size as untrusted and ensure adequate storage before materializing files
- Upload enablement is global across joined lishnets, as described above. Network-specific publication and download authorization are not implemented in version 0.0.1

## Planned extensions

The following features are planned and are NOT part of `/lish/0.0.1`.

### Synchronized LISH database

A network-wide, decentralized database of published LISH entries (an online library), so the network's content can be browsed without every publisher being online.

The wire messages, ordering, pagination, and incremental cursor model are not yet defined. A LISH UUID is random and cannot serve as an "entries after this ID" cursor. Any future incremental design must define a stable ordering and an opaque cursor or equivalent snapshot rule before implementations can interoperate.

Each database entry carries the LISH structure plus optional publication metadata:

```typescript
{
	lish: ILISH,        // LISH data format structure
	publisher?: string, // Peer ID that published the entry (optional if not required by the network)
	published?: string  // ISO 8601 timestamp of publication (optional if not required by the network)
}
```

Publishing adds an entry to the database; removing an entry is restricted to the network's owners and admins. The `publisher` field is metadata, not proof of authorship, until the extension defines signatures and key authorization.

### Network access control

Per-network roles restricting who may write into the synchronized database:

- **Owners** — edit network configuration, manage admins, publishers, and downloaders
- **Admins** — manage publishers and downloaders
- **Publishers** — publish new entries into the database
- **Downloaders** — download content when the network restricts downloading

Both restrictions are independent per-network opt-ins: a network may restrict publishing (only publishers may add entries), downloading (only downloaders may fetch content), both, or neither — the default is open.

### Other planned features

- **Compression** — optional chunk compression (zstd, brotli, ...)
- **Incentives** — token-based upload / download credits
- **Smart routing** — automatically route through the fastest paths
- **Private networks** — hide data availability unless specific conditions are met (authentication, payment, ...)
