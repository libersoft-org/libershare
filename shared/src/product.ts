import product from './product.json';

export const productName: string = product.name;
export const productVersion: string = product.version;
export const productIdentifier: string = product.identifier;
export const productWebsite: string = product.website;
export const productGithub: string = product.github;
export const productNetworkList: string = product.networkList;
export const DEFAULT_API_PORT: number = 1158;
export const DEFAULT_API_URL: string = `ws://localhost:${DEFAULT_API_PORT}`;
