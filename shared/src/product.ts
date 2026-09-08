import product from './product.json';

export const productName: string = product.name;
export const productVersion: string = product.version;
export const productIdentifier: string = product.identifier;
export const productWebsite: string = product.website;
export const productGithub: string = product.github;
export const productNetworkList: string = product.networkList;
export const productEnvPrefix: string = product.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const DEFAULT_API_PORT: number = 1158;
export const DEFAULT_API_URL: string = `ws://localhost:${DEFAULT_API_PORT}`;

/**
 * Largest single WebSocket message the API accepts, in bytes. Bun defaults to
 * 16 MiB and drops the whole connection on a bigger frame without telling the
 * caller why, so the backend sets this explicitly and the client refuses to send
 * anything larger with a real error instead.
 *
 * It doubles as the decompression output cap: a payload that could never travel
 * back over the API is not worth expanding in memory first.
 */
export const MAX_API_MESSAGE_SIZE: number = 128 * 1024 * 1024;

/**
 * Largest single `upload.chunk` payload, in bytes. An upload is a sequence of
 * these, so the frame limit above is the ceiling for a whole file rather than
 * for one message — without a separate per-chunk limit a client could send the
 * entire 128 MiB as one frame and defeat the point of chunking. It also bounds
 * what {@link decodeBinaryRequest} has to copy out of a frame before anything
 * about that frame has been validated.
 */
export const MAX_UPLOAD_CHUNK_SIZE: number = 4 * 1024 * 1024;
