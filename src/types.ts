export interface TrelloLabel {
  id: string;
  color: string;
  name: string;
}

export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
  labels: TrelloLabel[];
  shortUrl: string;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state?: 'incomplete' | 'complete';
}

export interface TrelloChecklist {
  id: string;
  name: string;
  idCard: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloWebhookEvent {
  action: {
    type: string;
    data: {
      card?: { id: string; name: string; desc: string; idList: string };
      list?: { id: string; name: string };
      text?: string;
      checkItem?: { id: string; name: string; state?: 'incomplete' | 'complete' };
      checklist?: { id: string; name: string };
    };
    memberCreator: { id: string; username: string };
  };
  model: { id: string };
}

export interface TrelloAuthConfig {
  type: 'apikey';
  apiKey: string;
  token: string;
}

export interface TrelloListsConfig {
  backlog: string;
  inProgress: string;
  done: string;
}

export interface TargetWebPricingConfig {
  enabled: boolean;
  pricingAgentId?: string;
  pollIntervalMs?: number;
}

export interface TrelloShoppingAutomationConfig {
  enabled: boolean;
  cardName: string;
  checklistName?: string;
  minimumSubtotal?: number;
  targetWeb: TargetWebPricingConfig;
}

export interface TrelloPluginConfig {
  enabled: boolean;
  auth: TrelloAuthConfig;
  boardId: string;
  webhookCallbackUrl: string;
  lists: TrelloListsConfig;
  agentLabels: Record<string, string>;
  defaultAgent?: string;
  interimResponseThresholdMs?: number;
  shoppingAutomation?: TrelloShoppingAutomationConfig;
}

export interface AgentSession {
  agentId: string;
  cardId: string;
  startedAt: Date;
  history: Array<{ role: 'user' | 'agent'; text: string; timestamp: Date }>;
}

export interface RoutedEvent {
  cardId: string;
  agentId: string;
  text: string;
  isFollowUp: boolean;
  session: AgentSession;
}

export interface ChecklistItemAddedEvent {
  cardId: string;
  cardName: string;
  checklistId?: string;
  checklistName?: string;
  checkItemId?: string;
  checkItemName: string;
}

export interface ShoppingCommentEvent {
  cardId: string;
  cardName: string;
  text: string;
}
