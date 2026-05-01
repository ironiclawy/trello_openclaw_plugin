export interface TrelloAuthProvider {
  /** Returns query string params to append to every Trello API request */
  getAuthParams(): Promise<Record<string, string>>;
  /** Returns the token for use in token-scoped API calls */
  getToken(): Promise<string>;
  /** Optional: refresh credentials (for future OAuth2 support) */
  refresh?(): Promise<void>;
}
