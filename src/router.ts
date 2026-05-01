import { TrelloLabel } from './types';

export class TrelloAgentRouter {
  constructor(
    private readonly agentLabels: Record<string, string>,
    private readonly defaultAgent?: string,
  ) {}

  /**
   * Returns the agent name for the first label that matches the configured mapping.
   * Falls back to defaultAgent if no label matches (or no labels present).
   */
  resolve(labels: TrelloLabel[]): string | undefined {
    for (const label of labels) {
      const agentId = this.agentLabels[label.color];
      if (agentId) return agentId;
    }
    return this.defaultAgent;
  }
}
