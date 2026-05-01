import { AgentSession } from './types';

export class TrelloSessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  get(cardId: string): AgentSession | undefined {
    return this.sessions.get(cardId);
  }

  create(cardId: string, agentId: string): AgentSession {
    const existing = this.sessions.get(cardId);
    if (existing) return existing;
    const session: AgentSession = {
      agentId,
      cardId,
      startedAt: new Date(),
      history: [],
    };
    this.sessions.set(cardId, session);
    return session;
  }

  appendHistory(cardId: string, role: 'user' | 'agent', text: string): void {
    const session = this.sessions.get(cardId);
    if (!session) throw new Error(`No session for card ${cardId}`);
    session.history.push({ role, text, timestamp: new Date() });
  }

  delete(cardId: string): void {
    this.sessions.delete(cardId);
  }
}
