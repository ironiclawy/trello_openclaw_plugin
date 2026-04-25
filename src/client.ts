import { TrelloAuthProvider } from './auth/provider';
import { TrelloCard, TrelloChecklist, TrelloList, TrelloLabel } from './types';

const BASE_URL = 'https://api.trello.com';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 300;
const DEFAULT_RETRY_MAX_MS = 5000;

export class TrelloClient {
  constructor(private readonly auth: TrelloAuthProvider) {}

  private get retryAttempts(): number {
    const parsed = Number(process.env.TRELLO_API_RETRY_ATTEMPTS || DEFAULT_RETRY_ATTEMPTS);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_RETRY_ATTEMPTS;
  }

  private get retryBaseDelayMs(): number {
    const parsed = Number(process.env.TRELLO_API_RETRY_BASE_MS || DEFAULT_RETRY_BASE_MS);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RETRY_BASE_MS;
  }

  private get retryMaxDelayMs(): number {
    const parsed = Number(process.env.TRELLO_API_RETRY_MAX_MS || DEFAULT_RETRY_MAX_MS);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RETRY_MAX_MS;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private isRetriableStatus(status: number): boolean {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }

  private parseRetryAfterMs(response: Response): number | undefined {
    const retryAfter = response.headers.get('retry-after');
    if (!retryAfter) return undefined;

    const asSeconds = Number(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.floor(asSeconds * 1000);
    }

    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return delta;
    }

    return undefined;
  }

  private isRetriableNetworkError(err: unknown): boolean {
    const message = String((err as any)?.message || '').toLowerCase();
    const name = String((err as any)?.name || '').toLowerCase();
    return name === 'aborterror'
      || message.includes('fetch failed')
      || message.includes('network')
      || message.includes('econnreset')
      || message.includes('etimedout')
      || message.includes('eai_again')
      || message.includes('socket hang up');
  }

  private async fetchWithRetry(url: string, init: RequestInit, operation: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok) return response;

        const retriable = this.isRetriableStatus(response.status) && attempt < this.retryAttempts;
        if (retriable) {
          const retryAfterMs = this.parseRetryAfterMs(response);
          const exponential = this.retryBaseDelayMs * Math.pow(2, attempt);
          const jitter = Math.floor(Math.random() * this.retryBaseDelayMs);
          const delayMs = Math.min(this.retryMaxDelayMs, retryAfterMs ?? (exponential + jitter));
          console.warn(`[TrelloClient] ${operation} attempt ${attempt + 1} got ${response.status}; retrying in ${delayMs}ms`);
          await this.sleep(delayMs);
          continue;
        }

        const text = await response.text();
        throw new Error(`Trello API error ${response.status}: ${text}`);
      } catch (err) {
        lastError = err;
        const retriable = this.isRetriableNetworkError(err) && attempt < this.retryAttempts;
        if (!retriable) throw err;

        const exponential = this.retryBaseDelayMs * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * this.retryBaseDelayMs);
        const delayMs = Math.min(this.retryMaxDelayMs, exponential + jitter);
        console.warn(`[TrelloClient] ${operation} network error on attempt ${attempt + 1}; retrying in ${delayMs}ms`);
        await this.sleep(delayMs);
      }
    }

    throw (lastError instanceof Error
      ? lastError
      : new Error(`[TrelloClient] ${operation} failed after retries`));
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private async buildUrl(path: string, params: Record<string, string> = {}): Promise<string> {
    const authParams = await this.auth.getAuthParams();
    const query = new URLSearchParams({ ...authParams, ...params });
    return `${BASE_URL}${path}?${query.toString()}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = await this.buildUrl(path, params);
    const response = await this.fetchWithRetry(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }, `${method} ${path}`);
    return this.parseJsonResponse<T>(response);
  }

  async getLists(boardId: string): Promise<TrelloList[]> {
    return this.request<TrelloList[]>('GET', `/1/boards/${boardId}/lists`);
  }

  async getLabels(boardId: string): Promise<TrelloLabel[]> {
    return this.request<TrelloLabel[]>('GET', `/1/boards/${boardId}/labels`);
  }

  async createList(boardId: string, name: string): Promise<TrelloList> {
    return this.request<TrelloList>('POST', '/1/lists', { name, idBoard: boardId });
  }

  async createLabel(boardId: string, name: string, color: string): Promise<TrelloLabel> {
    return this.request<TrelloLabel>('POST', '/1/labels', { name, color, idBoard: boardId });
  }

  async createCard(params: { idList: string; name: string; desc: string; labelIds: string[] }): Promise<TrelloCard> {
    return this.request<TrelloCard>('POST', '/1/cards', {
      idList: params.idList,
      name: params.name,
      desc: params.desc,
      idLabels: params.labelIds,
    });
  }

  async moveCard(cardId: string, listId: string): Promise<void> {
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, { idList: listId });
  }

  async updateDescription(cardId: string, desc: string): Promise<void> {
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, { desc });
  }

  async updateCardDates(
    cardId: string,
    params: { start?: string | null; due?: string | null; dueComplete?: boolean }
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (params.start !== undefined) body.start = params.start;
    if (params.due !== undefined) body.due = params.due;
    if (params.dueComplete !== undefined) body.dueComplete = params.dueComplete;
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, body);
  }

  async uploadAttachment(cardId: string, filename: string, data: Buffer, mimeType: string): Promise<{ id: string; url: string }> {
    const url = await this.buildUrl(`/1/cards/${cardId}/attachments`);
    const form = new FormData();
    form.append('name', filename);
    form.append('file', new Blob([data], { type: mimeType }), filename);
    const response = await this.fetchWithRetry(url, { method: 'POST', body: form }, `POST /1/cards/${cardId}/attachments (upload)`);
    return this.parseJsonResponse<{ id: string; url: string }>(response);
  }

  async setCardCoverToAttachment(cardId: string, attachmentId: string): Promise<void> {
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, { idAttachmentCover: attachmentId });
  }

  async attachLink(cardId: string, url: string, name?: string): Promise<{ id: string; url: string }> {
    const response = await this.request<{ id: string; url: string }>('POST', `/1/cards/${cardId}/attachments`, {
      url,
      ...(name ? { name } : {}),
    });
    return response;
  }

  async addMember(cardId: string, memberId: string): Promise<void> {
    const url = await this.buildUrl(`/1/cards/${cardId}/idMembers`);
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: memberId }),
    }, `POST /1/cards/${cardId}/idMembers`);
    await this.parseJsonResponse<Record<string, unknown>>(response);
  }

  async removeMember(cardId: string, memberId: string): Promise<void> {
    await this.request('DELETE', `/1/cards/${cardId}/idMembers/${memberId}`);
  }

  async setMembers(cardId: string, memberIds: string[]): Promise<void> {
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, {
      idMembers: memberIds.join(','),
    });
  }

  async addLabel(cardId: string, labelId: string): Promise<void> {
    await this.request('POST', `/1/cards/${cardId}/idLabels`, undefined, { value: labelId });
  }

  async removeLabel(cardId: string, labelId: string): Promise<void> {
    await this.request('DELETE', `/1/cards/${cardId}/idLabels/${labelId}`);
  }

  async addComment(cardId: string, text: string): Promise<void> {
    await this.request('POST', `/1/cards/${cardId}/actions/comments`, { text });
  }

  async updateComment(cardId: string, commentActionId: string, text: string): Promise<void> {
    await this.request('PUT', `/1/cards/${cardId}/actions/${commentActionId}/comments`, { text });
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>('GET', `/1/cards/${cardId}`);
  }

  async getCardChecklists(cardId: string): Promise<TrelloChecklist[]> {
    return this.request<TrelloChecklist[]>('GET', `/1/cards/${cardId}/checklists`, undefined, {
      checkItems: 'all',
      checkItem_fields: 'id,name,state',
      fields: 'id,name,idCard',
    });
  }

  async createChecklist(cardId: string, name: string): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>('POST', '/1/checklists', {
      idCard: cardId,
      name,
    });
  }

  async addChecklistItem(checklistId: string, name: string): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>('POST', `/1/checklists/${checklistId}/checkItems`, {
      name,
      pos: 'bottom',
    });
  }

  async getCardAttachments(cardId: string): Promise<Array<{ id: string; name?: string; url?: string; mimeType?: string; isUpload?: boolean }>> {
    return this.request<Array<{ id: string; name?: string; url?: string; mimeType?: string; isUpload?: boolean }>>(
      'GET',
      `/1/cards/${cardId}/attachments`,
      undefined,
      { fields: 'id,name,url,mimeType,isUpload' },
    );
  }

  async updateChecklistItemName(cardId: string, checkItemId: string, name: string): Promise<void> {
    await this.request('PUT', `/1/cards/${cardId}/checkItem/${checkItemId}`, { name });
  }

  async updateChecklistItemState(cardId: string, checkItemId: string, state: 'complete' | 'incomplete'): Promise<void> {
    await this.request('PUT', `/1/cards/${cardId}/checkItem/${checkItemId}`, { state });
  }

  async getCardComments(cardId: string, limit = 100): Promise<Array<{ id: string; date?: string; memberCreator?: { id?: string }; data?: { text?: string } }>> {
    return this.request<Array<{ id: string; date?: string; memberCreator?: { id?: string }; data?: { text?: string } }>>(
      'GET',
      `/1/cards/${cardId}/actions`,
      undefined,
      { filter: 'commentCard', limit: String(limit) },
    );
  }

  async getLatestCardListMoveAction(
    cardId: string,
  ): Promise<{ id: string; date?: string; data?: { listBefore?: { id?: string }; listAfter?: { id?: string } } } | undefined> {
    const actions = await this.request<Array<{ id: string; date?: string; data?: { listBefore?: { id?: string }; listAfter?: { id?: string } } }>>(
      'GET',
      `/1/cards/${cardId}/actions`,
      undefined,
      { filter: 'updateCard:idList', limit: '1' },
    );
    return actions[0];
  }

  async getCardCreationAction(
    cardId: string,
  ): Promise<{ id: string; memberCreator?: { id?: string; username?: string } } | undefined> {
    const actions = await this.request<Array<{ id: string; memberCreator?: { id?: string; username?: string } }>>(
      'GET',
      `/1/cards/${cardId}/actions`,
      undefined,
      { filter: 'createCard', limit: '1' },
    );
    return actions[0];
  }

  async archiveCard(cardId: string): Promise<void> {
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, { closed: true });
  }

  async markCardComplete(cardId: string): Promise<void> {
    await this.request<TrelloCard>('PUT', `/1/cards/${cardId}`, { dueComplete: true });
  }

  async getWebhooks(): Promise<{ id: string; callbackURL: string; idModel: string }[]> {
    return this.request<{ id: string; callbackURL: string; idModel: string }[]>('GET', '/1/tokens/' + await this.auth.getToken() + '/webhooks');
  }

  async registerWebhook(callbackUrl: string, boardId: string): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/1/webhooks', {
      callbackURL: callbackUrl,
      idModel: boardId,
      description: 'openclaw-plugin-trello',
    });
  }

  async registerOrReuseWebhook(callbackUrl: string, boardId: string): Promise<{ id: string }> {
    try {
      return await this.registerWebhook(callbackUrl, boardId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canReuseExisting = msg.includes('already exists') || msg.includes('VALIDATOR_URL_NOT_REACHABLE');
      if (canReuseExisting) {
        // If Trello cannot validate callback right now but webhook already exists,
        // reuse the existing registration instead of failing channel startup.
        const webhooks = await this.getWebhooks();
        const existing = webhooks.find(w => w.callbackURL === callbackUrl && w.idModel === boardId);
        if (existing) return { id: existing.id };
      }
      throw err;
    }
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request('DELETE', `/1/webhooks/${webhookId}`);
  }

  async getMe(): Promise<{ id: string; username: string }> {
    const url = await this.buildUrl('/1/members/me', { fields: 'id,username' });
    const response = await this.fetchWithRetry(url, { method: 'GET' }, 'GET /1/members/me');
    return this.parseJsonResponse<{ id: string; username: string }>(response);
  }

  async getBoard(boardId: string): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>('GET', `/1/boards/${boardId}`);
  }

  async getMemberBoards(): Promise<Array<{ id: string; name: string; closed?: boolean }>> {
    return this.request<Array<{ id: string; name: string; closed?: boolean }>>(
      'GET',
      '/1/members/me/boards',
      undefined,
      { fields: 'id,name,closed' },
    );
  }

  async getBoardCards(boardId: string): Promise<Array<{ id: string; name: string; idList: string }>> {
    return this.request<Array<{ id: string; name: string; idList: string }>>(
      'GET',
      `/1/boards/${boardId}/cards`,
      undefined,
      { fields: 'id,name,idList' },
    );
  }

  async getBoardMembers(boardId: string): Promise<Array<{ id: string; fullName?: string; username?: string; avatarUrl?: string }>> {
    return this.request<Array<{ id: string; fullName?: string; username?: string; avatarUrl?: string }>>(
      'GET',
      `/1/boards/${boardId}/members`,
      undefined,
      { fields: 'id,fullName,username,avatarUrl' },
    );
  }

  async getBoardPluginData(boardId: string): Promise<Array<{ idPlugin?: string; value?: string }>> {
    return this.request<Array<{ idPlugin?: string; value?: string }>>(
      'GET',
      `/1/boards/${boardId}/pluginData`,
    );
  }

  async findListByName(boardId: string, listName: string): Promise<TrelloList | undefined> {
    const lists = await this.getLists(boardId);
    return lists.find(list => list.name.trim().toLowerCase() === listName.trim().toLowerCase());
  }

  async findCardByName(
    boardId: string,
    cardName: string,
    opts: { listId?: string; includeArchived?: boolean } = {}
  ): Promise<{ id: string; name: string; idList: string } | undefined> {
    const cards = await this.request<Array<{ id: string; name: string; idList: string; closed?: boolean }>>(
      'GET',
      `/1/boards/${boardId}/cards`,
      undefined,
      { fields: 'id,name,idList,closed' },
    );
    return cards.find(card => {
      if (!opts.includeArchived && card.closed) return false;
      if (opts.listId && card.idList !== opts.listId) return false;
      return card.name.trim().toLowerCase() === cardName.trim().toLowerCase();
    });
  }
}
