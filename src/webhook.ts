import { TrelloAgentRouter } from './router';
import { TrelloSessionStore } from './session-store';
import { TrelloClient } from './client';
import { ChecklistItemAddedEvent, RoutedEvent, ShoppingCommentEvent, TrelloWebhookEvent } from './types';

interface WebhookHandlerOptions {
  router: TrelloAgentRouter;
  store: TrelloSessionStore;
  client: TrelloClient;
  botMemberId: string;
  isAutomationMember?: (boardId: string, memberId: string) => Promise<boolean> | boolean;
  onRoutedEvent: (event: RoutedEvent) => void;
  onChecklistItemAdded?: (event: ChecklistItemAddedEvent) => void;
  onShoppingComment?: (event: ShoppingCommentEvent) => Promise<boolean> | boolean;
  onEvaluateInboundCard?: (input: {
    card: any;
    boardId: string;
    text: string;
    eventType: 'createCard' | 'commentCard' | 'moveCard';
  }) => Promise<{ allow: boolean; text?: string }>;
}

export class TrelloWebhookHandler {
  private readonly router: TrelloAgentRouter;
  private readonly store: TrelloSessionStore;
  private readonly client: TrelloClient;
  private readonly botMemberId: string;
  private readonly isAutomationMember?: (boardId: string, memberId: string) => Promise<boolean> | boolean;
  private readonly onRoutedEvent: (event: RoutedEvent) => void;
  private readonly onChecklistItemAdded?: (event: ChecklistItemAddedEvent) => void;
  private readonly onShoppingComment?: (event: ShoppingCommentEvent) => Promise<boolean> | boolean;
  private readonly onEvaluateInboundCard?: (input: {
    card: any;
    boardId: string;
    text: string;
    eventType: 'createCard' | 'commentCard' | 'moveCard';
  }) => Promise<{ allow: boolean; text?: string }>;

  constructor(options: WebhookHandlerOptions) {
    this.router = options.router;
    this.store = options.store;
    this.client = options.client;
    this.botMemberId = options.botMemberId;
    this.isAutomationMember = options.isAutomationMember;
    this.onRoutedEvent = options.onRoutedEvent;
    this.onChecklistItemAdded = options.onChecklistItemAdded;
    this.onShoppingComment = options.onShoppingComment;
    this.onEvaluateInboundCard = options.onEvaluateInboundCard;
  }

  handle(req: any, res: any): void {
    if (req.method === 'HEAD') {
      res.sendStatus(200);
      return;
    }

    res.sendStatus(200);

    this.processEvent(req.body).catch(err => {
      console.error('[TrelloChannel] Error processing webhook event:', err);
    });
  }

  private formatRecentSessionHistory(cardId: string, limit = 8): string {
    const session = this.store.get(cardId);
    if (!session?.history?.length) return '';

    const recent = session.history.slice(-limit);
    const lines = recent.map(entry => {
      const role = entry.role === 'agent' ? 'Agent' : 'User';
      const text = String(entry.text || '').trim();
      return text ? `- ${role}: ${text}` : '';
    }).filter(Boolean);
    return lines.join('\n');
  }

  private buildCommentDispatchText(input: {
    commentText: string;
    fullCard: any;
    event: TrelloWebhookEvent;
    cardId: string;
  }): string {
    const commentText = String(input.commentText || '').trim();
    const boardName = String((input.event as any)?.action?.data?.board?.name || '').trim();
    const listName = String((input.event as any)?.action?.data?.list?.name || '').trim();
    const cardTitle = String((input.fullCard as any)?.name || '').trim();
    const cardDesc = String((input.fullCard as any)?.desc || '').trim();
    const sessionHistory = this.formatRecentSessionHistory(input.cardId);

    const sections: string[] = [];
    sections.push('Trello Context:');
    if (boardName) sections.push(`Board: ${boardName}`);
    if (listName) sections.push(`List: ${listName}`);
    if (cardTitle) sections.push(`Card: ${cardTitle}`);
    if (cardDesc) sections.push(`Card Description: ${cardDesc}`);
    if (sessionHistory) {
      sections.push('Recent Thread History:');
      sections.push(sessionHistory);
    }
    sections.push('New User Comment:');
    sections.push(commentText || '(empty comment)');

    return sections.join('\n\n');
  }

  private async processEvent(body: unknown): Promise<void> {
    const event = body as TrelloWebhookEvent;
    if (!event?.action) return;

    const { type, data, memberCreator } = event.action;
    const actionData = data as any;

    if (type === 'createCheckItem') {
      const card = data.card;
      const checkItem = data.checkItem;
      if (card && checkItem && this.onChecklistItemAdded) {
        this.onChecklistItemAdded({
          cardId: card.id,
          cardName: card.name,
          checklistId: data.checklist?.id,
          checklistName: data.checklist?.name,
          checkItemId: checkItem.id,
          checkItemName: checkItem.name,
        });
      }
      return;
    }

    const isListMove = type === 'updateCard'
      && !!data?.card?.id
      && !!actionData?.listBefore?.id
      && !!actionData?.listAfter?.id
      && actionData.listBefore.id !== actionData.listAfter.id;

    if (isListMove) {
      console.log(
        `[TrelloChannel][move] received cardId=${String(data?.card?.id || '')} ` +
        `from=${String(actionData?.listBefore?.id || '')} to=${String(actionData?.listAfter?.id || '')} ` +
        `creator=${String(memberCreator?.id || '')}`
      );
    }

    if (type !== 'createCard' && type !== 'commentCard' && !isListMove) return;

    if (type === 'commentCard') {
      const authorId = String(memberCreator?.id || '').trim();
      const commentText = String(data?.text || '').trim();
      const boardId = String(actionData?.board?.id || (event as any)?.model?.id || '').trim();

      // Only user-authored comments should trigger routed follow-up handling.
      if (!authorId) {
        console.log(`[TrelloChannel][comment] ignored missing-author comment cardId=${String(data?.card?.id || '')}`);
        return;
      }
      if (this.botMemberId && authorId === this.botMemberId) {
        console.log(`[TrelloChannel][comment] ignored bot-authored comment cardId=${String(data?.card?.id || '')}`);
        return;
      }
      if (boardId && this.isAutomationMember) {
        try {
          const authoredByAutomation = await this.isAutomationMember(boardId, authorId);
          if (authoredByAutomation) {
            console.log(`[TrelloChannel][comment] ignored automation-authored comment cardId=${String(data?.card?.id || '')} author=${authorId}`);
            return;
          }
        } catch {
          // best-effort guard only
        }
      }
      if (!commentText) {
        console.log(`[TrelloChannel][comment] ignored empty comment cardId=${String(data?.card?.id || '')}`);
        return;
      }
    }

    if (isListMove && this.botMemberId && memberCreator?.id === this.botMemberId) {
      if (isListMove) {
        console.log(`[TrelloChannel][move] ignored bot-authored move cardId=${String(data?.card?.id || '')}`);
      }
      return;
    }

    const card = data.card;
    if (!card) return;

    if (type === 'commentCard' && this.onShoppingComment) {
      const handled = await this.onShoppingComment({
        cardId: card.id,
        cardName: card.name,
        text: data.text ?? '',
      });
      if (handled) return;
    }

    const existingSession = this.store.get(card.id);

    let agentId: string | undefined;
    let fullCard: any = null;
    if (existingSession) {
      agentId = existingSession.agentId;
    } else {
      if (type === 'createCard') await new Promise(r => setTimeout(r, 2000));

      try {
        fullCard = await this.client.getCard(card.id);
      } catch (err) {
        console.error(`[TrelloChannel] Failed to fetch card ${card.id}:`, err);
        return;
      }

      agentId = this.router.resolve(fullCard.labels ?? []);
    }

    if (!fullCard) {
      try {
        fullCard = await this.client.getCard(card.id);
      } catch (err) {
        console.error(`[TrelloChannel] Failed to fetch card ${card.id}:`, err);
        return;
      }
    }

    let text: string;
    if (type === 'commentCard') {
      text = this.buildCommentDispatchText({
        commentText: data.text ?? '',
        fullCard,
        event,
        cardId: card.id,
      });
    } else {
      const title = fullCard?.name ?? card.name ?? '';
      const desc = (fullCard?.desc ?? '').trim();
      text = desc ? `${title}\n\n${desc}` : title;
    }

    if (!text || !text.trim()) {
      if (isListMove) {
        console.log(`[TrelloChannel][move] ignored empty text cardId=${String(card.id || '')}`);
      }
      return;
    }

    if (!existingSession && fullCard && this.onEvaluateInboundCard && (type === 'createCard' || isListMove)) {
      const boardId = String((fullCard as any)?.idBoard || (event as any)?.model?.id || '').trim();
      const decision = await this.onEvaluateInboundCard({
        card: fullCard,
        boardId,
        text,
        eventType: isListMove ? 'moveCard' : (type as 'createCard' | 'commentCard'),
      });
      if (!decision?.allow) {
        if (isListMove) {
          console.log(`[TrelloChannel][move] rejected by inbound evaluator cardId=${String(card.id || '')}`);
        }
        return;
      }
      if (typeof decision.text === 'string' && decision.text.trim()) {
        text = decision.text;
      }
    }

    if (!agentId) {
      if (isListMove) {
        console.log(`[TrelloChannel][move] rejected no-agent cardId=${String(card.id || '')}`);
      }
      try {
        await this.client.addComment(
          card.id,
          '⚠️ No agent assigned. Configure agentLabels in the plugin config to route cards by label, or set a defaultAgent.'
        );
      } catch (err) {
        console.error('[TrelloChannel] Failed to post error comment:', err);
      }
      return;
    }

    const session = existingSession ?? this.store.create(card.id, agentId);
    // Sessions are cleared after each handled event; treat user comments as follow-ups
    // so they bypass first-intake gating and reliably continue the thread.
    const isFollowUp = !!existingSession || type === 'commentCard';

    if (isListMove) {
      console.log(`[TrelloChannel][move] routing cardId=${String(card.id || '')} followUp=${String(isFollowUp)} agent=${String(agentId || '')}`);
    }
    if (type === 'commentCard') {
      console.log(`[TrelloChannel][comment] routing cardId=${String(card.id || '')} followUp=${String(isFollowUp)} agent=${String(agentId || '')}`);
    }

    this.onRoutedEvent({ cardId: card.id, agentId, text, isFollowUp, session });
  }
}
