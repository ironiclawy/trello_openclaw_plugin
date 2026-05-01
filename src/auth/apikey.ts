import { TrelloAuthProvider } from './provider';
import { TrelloAuthConfig } from '../types';

export class ApiKeyAuthProvider implements TrelloAuthProvider {
  private readonly apiKey: string;
  private readonly token: string;

  constructor(config: TrelloAuthConfig) {
    if (!config.apiKey) throw new Error('Trello apiKey is required');
    if (!config.token) throw new Error('Trello token is required');
    this.apiKey = config.apiKey;
    this.token = config.token;
  }

  async getAuthParams(): Promise<Record<string, string>> {
    return { key: this.apiKey, token: this.token };
  }

  async getToken(): Promise<string> {
    return this.token;
  }
}
