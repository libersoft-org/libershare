import { wsClient } from './ws-client';
import { Api } from '@libershare/shared';

export const api = new Api(wsClient);