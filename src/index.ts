import { TrelloClient } from './client';
import { ApiKeyAuthProvider } from './auth/apikey';
import { TrelloAgentRouter } from './router';
import { TrelloSessionStore } from './session-store';
import { BoardIds } from './board-setup';
import { TrelloWebhookHandler } from './webhook';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  ChecklistItemAddedEvent,
  RoutedEvent,
  ShoppingCommentEvent,
  TrelloCard,
  TrelloChecklist,
  TrelloPluginConfig,
  TrelloShoppingAutomationConfig,
} from './types';
import { createTrelloTools } from './tools';
import { buildDemoScriptWorkflowResponse, matchDemoScriptPrompt } from './demo-script';

export { TrelloPluginConfig } from './types';

const THRESHOLD_MARKER = '#target-threshold-met';
const READY_CHECKOUT_LABEL_NAME = 'Ready to checkout';
const GENERATED_IMAGE_DIR = '/tmp/openclaw-trello-generated-images';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME
  || (existsSync('/home/node/.openclaw') ? '/home/node/.openclaw' : path.join(process.cwd(), '.openclaw'));
const OPENCLAW_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || path.join(OPENCLAW_HOME, 'workspace');
const OPENCLAW_MEDIA_DIR = process.env.OPENCLAW_MEDIA_DIR || path.join(OPENCLAW_HOME, 'media/tool-image-generation');

const DEFAULT_PLUGIN_CONFIG: TrelloPluginConfig = {
  enabled: true,
  auth: {
    type: 'apikey',
    apiKey: '',
    token: '',
  },
  boardId: '',
  webhookCallbackUrl: '',
  lists: {
    backlog: 'Backlog',
    inProgress: 'In Progress',
    done: 'Done',
  },
  agentLabels: {},
  defaultAgent: 'main',
  shoppingAutomation: {
    enabled: false,
    cardName: 'Target Shopping list',
    minimumSubtotal: 35,
    targetWeb: {
      enabled: false,
      pricingAgentId: 'ironiclawy',
      pollIntervalMs: 15000,
    },
  },
};

function assertNoUnknownKeys(value: Record<string, unknown>, allowed: string[], scope: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Invalid plugin config: unknown key ${scope}.${key}`);
    }
  }
}

function ensurePlainObject(value: unknown, scope: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid plugin config: ${scope} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validatePluginConfigShape(src: Record<string, unknown>): void {
  assertNoUnknownKeys(
    src,
    ['enabled', 'auth', 'boardId', 'webhookCallbackUrl', 'lists', 'agentLabels', 'defaultAgent', 'shoppingAutomation', 'interimResponseThresholdMs'],
    'config',
  );

  if ('enabled' in src && typeof src.enabled !== 'boolean') {
    throw new Error('Invalid plugin config: config.enabled must be a boolean');
  }
  if ('boardId' in src && typeof src.boardId !== 'string') {
    throw new Error('Invalid plugin config: config.boardId must be a string');
  }
  if ('webhookCallbackUrl' in src && typeof src.webhookCallbackUrl !== 'string') {
    throw new Error('Invalid plugin config: config.webhookCallbackUrl must be a string');
  }
  if ('defaultAgent' in src && typeof src.defaultAgent !== 'string') {
    throw new Error('Invalid plugin config: config.defaultAgent must be a string');
  }
  if ('interimResponseThresholdMs' in src && typeof src.interimResponseThresholdMs !== 'number') {
    throw new Error('Invalid plugin config: config.interimResponseThresholdMs must be a number');
  }

  if ('auth' in src) {
    const auth = ensurePlainObject(src.auth, 'config.auth');
    assertNoUnknownKeys(auth, ['type', 'apiKey', 'token'], 'config.auth');
    if ('type' in auth && typeof auth.type !== 'string') {
      throw new Error('Invalid plugin config: config.auth.type must be a string');
    }
    if ('apiKey' in auth && typeof auth.apiKey !== 'string') {
      throw new Error('Invalid plugin config: config.auth.apiKey must be a string');
    }
    if ('token' in auth && typeof auth.token !== 'string') {
      throw new Error('Invalid plugin config: config.auth.token must be a string');
    }
  }

  if ('lists' in src) {
    const lists = ensurePlainObject(src.lists, 'config.lists');
    assertNoUnknownKeys(lists, ['backlog', 'inProgress', 'done'], 'config.lists');
    if ('backlog' in lists && typeof lists.backlog !== 'string') {
      throw new Error('Invalid plugin config: config.lists.backlog must be a string');
    }
    if ('inProgress' in lists && typeof lists.inProgress !== 'string') {
      throw new Error('Invalid plugin config: config.lists.inProgress must be a string');
    }
    if ('done' in lists && typeof lists.done !== 'string') {
      throw new Error('Invalid plugin config: config.lists.done must be a string');
    }
  }

  if ('agentLabels' in src) {
    const agentLabels = ensurePlainObject(src.agentLabels, 'config.agentLabels');
    for (const [labelName, agentId] of Object.entries(agentLabels)) {
      if (typeof agentId !== 'string') {
        throw new Error(`Invalid plugin config: config.agentLabels.${labelName} must map to a string agent id`);
      }
    }
  }

  if ('shoppingAutomation' in src) {
    const shoppingAutomation = ensurePlainObject(src.shoppingAutomation, 'config.shoppingAutomation');
    assertNoUnknownKeys(shoppingAutomation, ['enabled', 'cardName', 'minimumSubtotal', 'targetWeb'], 'config.shoppingAutomation');

    if ('enabled' in shoppingAutomation && typeof shoppingAutomation.enabled !== 'boolean') {
      throw new Error('Invalid plugin config: config.shoppingAutomation.enabled must be a boolean');
    }
    if ('cardName' in shoppingAutomation && typeof shoppingAutomation.cardName !== 'string') {
      throw new Error('Invalid plugin config: config.shoppingAutomation.cardName must be a string');
    }
    if ('minimumSubtotal' in shoppingAutomation && typeof shoppingAutomation.minimumSubtotal !== 'number') {
      throw new Error('Invalid plugin config: config.shoppingAutomation.minimumSubtotal must be a number');
    }

    if ('targetWeb' in shoppingAutomation) {
      const targetWeb = ensurePlainObject(shoppingAutomation.targetWeb, 'config.shoppingAutomation.targetWeb');
      assertNoUnknownKeys(targetWeb, ['enabled', 'pricingAgentId', 'pollIntervalMs'], 'config.shoppingAutomation.targetWeb');

      if ('enabled' in targetWeb && typeof targetWeb.enabled !== 'boolean') {
        throw new Error('Invalid plugin config: config.shoppingAutomation.targetWeb.enabled must be a boolean');
      }
      if ('pricingAgentId' in targetWeb && typeof targetWeb.pricingAgentId !== 'string') {
        throw new Error('Invalid plugin config: config.shoppingAutomation.targetWeb.pricingAgentId must be a string');
      }
      if ('pollIntervalMs' in targetWeb && typeof targetWeb.pollIntervalMs !== 'number') {
        throw new Error('Invalid plugin config: config.shoppingAutomation.targetWeb.pollIntervalMs must be a number');
      }
    }
  }
}

function normalizePluginConfig(input: any): TrelloPluginConfig {
  const src = input && typeof input === 'object' ? input : {};
  validatePluginConfigShape(src);
  return {
    ...DEFAULT_PLUGIN_CONFIG,
    ...src,
    auth: {
      ...DEFAULT_PLUGIN_CONFIG.auth,
      ...(src.auth || {}),
    },
    lists: {
      ...DEFAULT_PLUGIN_CONFIG.lists,
      ...(src.lists || {}),
    },
    agentLabels: {
      ...(src.agentLabels || {}),
    },
    shoppingAutomation: {
      ...DEFAULT_PLUGIN_CONFIG.shoppingAutomation,
      ...(src.shoppingAutomation || {}),
      targetWeb: {
        ...DEFAULT_PLUGIN_CONFIG.shoppingAutomation!.targetWeb,
        ...((src.shoppingAutomation && src.shoppingAutomation.targetWeb) || {}),
      },
    },
  };
}

interface PricedChecklistItem {
  checkItemId: string;
  baseName: string;
  quantity: number;
  lineTotal: number;
  unitPrice?: number;
  productTitle?: string;
  productUrl?: string;
}

interface WorkflowOperation {
  op: string;
  cardName?: string;
  cardDesc?: string;
  allowCrossCard?: boolean;
  listName?: string;
  listId?: string;
  checklistName?: string;
  checklistItemName?: string;
  checklistItemNewName?: string;
  checklistItemId?: string;
  labelName?: string;
  labelColor?: string;
  labelId?: string;
  memberId?: string;
  memberIds?: string[];
  due?: string | null;
  start?: string | null;
  dueComplete?: boolean;
  commentText?: string;
  commentMatchText?: string;
  url?: string;
  filename?: string;
}

interface WorkflowExecutionResult {
  op: string;
  ok: boolean;
  detail: string;
}

interface AgentUsageStats {
  dispatches: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastSeenAt: number;
}

const trelloPowerupStats = {
  sessionStarted: 0,
  sessionCompleted: 0,
  sessionFailed: 0,
  activeSessions: 0,
  dispatches: 0,
  dispatchErrors: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  lastDispatchAt: 0,
  lastErrorAt: 0,
  agents: new Map<string, AgentUsageStats>(),
};

function ensureAgentUsageStats(agentId: string): AgentUsageStats {
  const key = String(agentId || 'unknown').trim() || 'unknown';
  const existing = trelloPowerupStats.agents.get(key);
  if (existing) return existing;

  const created: AgentUsageStats = {
    dispatches: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastSeenAt: 0,
  };
  trelloPowerupStats.agents.set(key, created);
  return created;
}

function addUsageFromResponse(agentId: string, payload: any): void {
  const usage = payload?.usage || payload?.choices?.[0]?.usage || payload?.response_metadata?.usage;
  if (!usage || typeof usage !== 'object') return;

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens)) || (promptTokens + completionTokens);
  const now = Date.now();

  trelloPowerupStats.promptTokens += promptTokens;
  trelloPowerupStats.completionTokens += completionTokens;
  trelloPowerupStats.totalTokens += totalTokens;

  const perAgent = ensureAgentUsageStats(agentId);
  perAgent.promptTokens += promptTokens;
  perAgent.completionTokens += completionTokens;
  perAgent.totalTokens += totalTokens;
  perAgent.lastSeenAt = now;
}

function trackDispatchStart(agentId: string): void {
  const now = Date.now();
  trelloPowerupStats.dispatches += 1;
  trelloPowerupStats.lastDispatchAt = now;
  const perAgent = ensureAgentUsageStats(agentId);
  perAgent.dispatches += 1;
  perAgent.lastSeenAt = now;
}

function trackDispatchError(): void {
  trelloPowerupStats.dispatchErrors += 1;
  trelloPowerupStats.lastErrorAt = Date.now();
}

function buildPowerupStatsPayload() {
  const agents = Array.from(trelloPowerupStats.agents.entries())
    .map(([agentId, stats]) => ({
      agentId,
      dispatches: stats.dispatches,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      totalTokens: stats.totalTokens,
      lastSeenAt: stats.lastSeenAt,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    generatedAt: Date.now(),
    sessions: {
      started: trelloPowerupStats.sessionStarted,
      completed: trelloPowerupStats.sessionCompleted,
      failed: trelloPowerupStats.sessionFailed,
      active: trelloPowerupStats.activeSessions,
    },
    usage: {
      dispatches: trelloPowerupStats.dispatches,
      dispatchErrors: trelloPowerupStats.dispatchErrors,
      promptTokens: trelloPowerupStats.promptTokens,
      completionTokens: trelloPowerupStats.completionTokens,
      totalTokens: trelloPowerupStats.totalTokens,
      lastDispatchAt: trelloPowerupStats.lastDispatchAt,
      lastErrorAt: trelloPowerupStats.lastErrorAt,
    },
    agents,
  };
}

const WORKFLOW_CONTRACT_VERSION = '1.0.0';
const WORKFLOW_ALLOWED_OPS = new Set([
  'attach_self',
  'assign_self',
  'create_card',
  'update_description',
  'move_card',
  'set_dates',
  'add_member',
  'add_creator_member',
  'remove_member',
  'set_members',
  'add_label',
  'remove_label',
  'add_checklist_item',
  'update_checklist_item',
  'complete_checklist_item',
  'add_comment',
  'update_comment',
  'attach_link',
  'attach_remote_file',
  'mark_complete',
  'archive_card',
]);
const WORKFLOW_ALLOWED_KEYS = new Set([
  'op',
  'cardName',
  'cardDesc',
  'allowCrossCard',
  'listName',
  'listId',
  'checklistName',
  'checklistItemName',
  'checklistItemNewName',
  'checklistItemId',
  'labelName',
  'labelColor',
  'labelId',
  'memberId',
  'memberIds',
  'due',
  'start',
  'dueComplete',
  'commentText',
  'commentMatchText',
  'url',
  'filename',
  'mimeType',
  'setAsCover',
  // legacy aliases accepted for compatibility
  'desc',
  'text',
  'matchText',
]);

const _g = (global as any);
if (!_g.__trelloPlugin) _g.__trelloPlugin = { instance: null, routeHandlers: {} };
function _getInstance(): TrelloChannel | null { return _g.__trelloPlugin.instance; }
function _setInstance(v: TrelloChannel) { _g.__trelloPlugin.instance = v; }
function _getRouteHandlers(): Record<string, (req: any, res: any) => void> { return _g.__trelloPlugin.routeHandlers; }

function adaptReqRes(rawReq: any, rawRes: any) {
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(String(rawReq.url || ''), 'http://localhost');
  } catch {
    parsedUrl = null;
  }

  const query: Record<string, string> = {};
  if (parsedUrl) {
    for (const [k, v] of parsedUrl.searchParams.entries()) {
      query[k] = v;
    }
  }

  const req = {
    method: rawReq.method,
    path: parsedUrl?.pathname || rawReq.url,
    headers: rawReq.headers,
    body: {} as any,
    params: {} as any,
    query,
    rawBody: '',
  };
  const res = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; rawRes.statusCode = code; return this; },
    json(data: any) { rawRes.setHeader('Content-Type', 'application/json'); rawRes.end(JSON.stringify(data)); },
    send(data: any) { rawRes.end(typeof data === 'string' ? data : JSON.stringify(data)); },
    end: () => { rawRes.end(); },
    setHeader: (k: string, v: string) => rawRes.setHeader(k, v),
    sendStatus(code: number) { rawRes.statusCode = code; rawRes.end(); },
  };
  return { req, res };
}

async function readJsonBodyIntoReq(rawReq: any, req: any): Promise<void> {
  await new Promise<void>((resolve) => {
    const chunks: Buffer[] = [];
    rawReq.on('data', (c: Buffer) => chunks.push(c));
    rawReq.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      req.rawBody = rawBody;
      try {
        req.body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        req.body = {};
      }
      resolve();
    });
    rawReq.on('error', resolve);
  });
}

function setPowerupCorsHeaders(rawReq: any, rawRes: any, methods = 'GET,POST,OPTIONS'): void {
  const origin = String(rawReq?.headers?.origin || '');
  // Power-Up iframes run on the connector host, not trello.com. Allow any HTTPS origin
  // so board settings and modal fetches can reach these endpoints from hosted assets.
  if (/^https:\/\//i.test(origin)) {
    rawRes.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    rawRes.setHeader('Access-Control-Allow-Origin', 'https://trello.com');
  }
  rawRes.setHeader('Access-Control-Allow-Methods', methods);
  rawRes.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  rawRes.setHeader('Vary', 'Origin');
}

function getHeaderValue(headers: any, key: string): string {
  const value = headers?.[key] ?? headers?.[key.toLowerCase()] ?? headers?.[key.toUpperCase()];
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function safeCompareString(a: string, b: string): boolean {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function validateWebhookAuth(req: any, config: TrelloPluginConfig): { ok: boolean; reason?: string } {
  const signature = getHeaderValue(req?.headers, 'x-trello-webhook');
  if (!signature) {
    return { ok: false, reason: 'missing x-trello-webhook signature header' };
  }

  const expectedToken = String(process.env.TRELLO_WEBHOOK_VERIFY_TOKEN || '').trim();
  if (expectedToken) {
    const providedToken = String(req?.query?.token || getHeaderValue(req?.headers, 'x-webhook-token') || '').trim();
    if (!providedToken || !safeCompareString(providedToken, expectedToken)) {
      return { ok: false, reason: 'webhook token verification failed' };
    }
  }

  const appSecret = String(process.env.TRELLO_WEBHOOK_APP_SECRET || '').trim();
  if (appSecret) {
    const rawBody = String(req?.rawBody || '');
    const callbackUrl = String(config.webhookCallbackUrl || '');
    const expectedSignature = createHmac('sha1', appSecret)
      .update(rawBody + callbackUrl)
      .digest('base64');
    if (!safeCompareString(signature, expectedSignature)) {
      return { ok: false, reason: 'webhook signature verification failed' };
    }
  }

  return { ok: true };
}

function extractWebhookBoardId(payload: any): string {
  const modelBoardId = String(payload?.model?.id || '').trim();
  if (modelBoardId) return modelBoardId;

  const actionBoardId = String(payload?.action?.data?.board?.id || '').trim();
  if (actionBoardId) return actionBoardId;

  const cardBoardId = String(payload?.action?.data?.card?.idBoard || '').trim();
  if (cardBoardId) return cardBoardId;

  return '';
}

function validateWebhookPayloadForBoard(payload: any): { ok: boolean; reason?: string; boardId?: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'payload is not an object' };
  }

  const actionType = String(payload?.action?.type || '').trim();
  if (!actionType) {
    return { ok: false, reason: 'missing action type' };
  }

  const payloadBoardId = extractWebhookBoardId(payload);
  if (!payloadBoardId) {
    return { ok: false, reason: 'missing board id in webhook payload' };
  }

  return { ok: true, boardId: payloadBoardId };
}

const WEBHOOK_DEDUPE_TTL_MS = Math.max(10_000, Number(process.env.TRELLO_WEBHOOK_DEDUPE_TTL_MS || 5 * 60_000));
const WEBHOOK_DEDUPE_MAX_SIZE = Math.max(100, Number(process.env.TRELLO_WEBHOOK_DEDUPE_MAX_SIZE || 2000));
const WEBHOOK_METRICS_LOG_INTERVAL_MS = Math.max(15_000, Number(process.env.TRELLO_WEBHOOK_METRICS_LOG_INTERVAL_MS || 60_000));
const BACKLOG_RECOVERY_RECHECK_MS = Math.max(10_000, Number(process.env.TRELLO_BACKLOG_RECOVERY_RECHECK_MS || 30_000));

const webhookSeenEvents = new Map<string, number>();
const webhookInFlightEvents = new Set<string>();
const webhookIngressMetrics = {
  accepted: 0,
  deduped: 0,
  dropped: 0,
  retried: 0,
  lastLogAt: 0,
};

function buildWebhookEventKey(payload: any): string {
  const actionId = String(payload?.action?.id || '').trim();
  if (actionId) return `action:${actionId}`;

  const actionType = String(payload?.action?.type || '').trim().toLowerCase();
  const cardId = String(payload?.action?.data?.card?.id || payload?.action?.data?.card?.idCard || '').trim();
  const date = String(payload?.action?.date || '').trim();
  if (actionType || cardId || date) {
    return `fallback:${actionType}:${cardId}:${date}`;
  }

  return '';
}

function pruneWebhookSeenEvents(now: number): void {
  for (const [eventKey, seenAt] of webhookSeenEvents) {
    if ((now - seenAt) > WEBHOOK_DEDUPE_TTL_MS) {
      webhookSeenEvents.delete(eventKey);
    }
  }

  while (webhookSeenEvents.size > WEBHOOK_DEDUPE_MAX_SIZE) {
    const oldestKey = webhookSeenEvents.keys().next().value;
    if (!oldestKey) break;
    webhookSeenEvents.delete(oldestKey);
  }
}

function maybeLogWebhookIngressMetrics(force = false): void {
  const now = Date.now();
  if (!force && (now - webhookIngressMetrics.lastLogAt) < WEBHOOK_METRICS_LOG_INTERVAL_MS) {
    return;
  }

  webhookIngressMetrics.lastLogAt = now;
  console.log(
    `[TrelloChannel][webhook-metrics] accepted=${webhookIngressMetrics.accepted} ` +
    `deduped=${webhookIngressMetrics.deduped} dropped=${webhookIngressMetrics.dropped} ` +
    `retried=${webhookIngressMetrics.retried} cacheSize=${webhookSeenEvents.size} inflight=${webhookInFlightEvents.size}`
  );
}

function beginWebhookEvent(eventKey: string): { accepted: boolean; reason?: 'deduped' | 'inflight' } {
  if (!eventKey) {
    webhookIngressMetrics.accepted += 1;
    maybeLogWebhookIngressMetrics();
    return { accepted: true };
  }

  const now = Date.now();
  pruneWebhookSeenEvents(now);

  const seenAt = webhookSeenEvents.get(eventKey);
  if (typeof seenAt === 'number' && (now - seenAt) <= WEBHOOK_DEDUPE_TTL_MS) {
    webhookIngressMetrics.deduped += 1;
    maybeLogWebhookIngressMetrics();
    return { accepted: false, reason: 'deduped' };
  }

  if (webhookInFlightEvents.has(eventKey)) {
    webhookIngressMetrics.dropped += 1;
    maybeLogWebhookIngressMetrics();
    return { accepted: false, reason: 'inflight' };
  }

  webhookSeenEvents.set(eventKey, now);
  webhookInFlightEvents.add(eventKey);
  webhookIngressMetrics.accepted += 1;
  maybeLogWebhookIngressMetrics();
  return { accepted: true };
}

function endWebhookEvent(eventKey: string): void {
  if (!eventKey) return;
  webhookInFlightEvents.delete(eventKey);
}

async function dispatchToOpenClawAgent(agentId: string, message: string, sessionId: string, cardId?: string): Promise<string> {
  trackDispatchStart(agentId);
  const promptInstructionMarker = '\n\nList Instructions (from Prompt card, MANDATORY):\n';
  const promptInstructionSuffix = '\n\nApply these instructions directly. Do not ask the user to repeat or paste them.';

  let userMessage = String(message || '');
  let listPromptInstructions = '';
  const markerIndex = userMessage.indexOf(promptInstructionMarker);
  if (markerIndex >= 0) {
    const basePart = userMessage.slice(0, markerIndex).trim();
    const instructionPartRaw = userMessage.slice(markerIndex + promptInstructionMarker.length);
    const suffixIndex = instructionPartRaw.indexOf(promptInstructionSuffix);
    const instructionPart = (suffixIndex >= 0 ? instructionPartRaw.slice(0, suffixIndex) : instructionPartRaw).trim();
    if (instructionPart) {
      listPromptInstructions = instructionPart;
      userMessage = basePart || userMessage;
    }
  }

  let runtimeCfg: any = null;
  try {
    const fs = require('fs');
    const configCandidates = [
      path.join(OPENCLAW_HOME, 'openclaw.json'),
      '/home/node/.openclaw/openclaw.json',
      '/root/.openclaw/openclaw.json',
    ];

    for (const cfgPath of configCandidates) {
      try {
        if (!fs.existsSync(cfgPath)) continue;
        const raw = fs.readFileSync(cfgPath, 'utf8');
        runtimeCfg = JSON.parse(raw);
        break;
      } catch {
        // Try next candidate.
      }
    }
  } catch (_err) {
    runtimeCfg = null;
  }

  const GATEWAY_TOKEN = (() => {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
    if (process.env.GATEWAY_AUTH_TOKEN) return process.env.GATEWAY_AUTH_TOKEN;
    if (process.env.OPENCLAW_TOKEN) return process.env.OPENCLAW_TOKEN;
    const token = runtimeCfg?.gateway?.auth?.token;
    if (typeof token === 'string' && token.length > 0) return token;
    return '';
  })();

  if (!GATEWAY_TOKEN) {
    throw new Error('Gateway token unavailable for dispatchToOpenClawAgent');
  }

  const wantsPdf = /\b(pdf|attach.*report|attach.*document|report.*attach|save as (pdf|file)|generate.*pdf)\b/i.test(userMessage);
  const wantsImage = /\b(image|picture|photo|illustration|drawing|artwork|generate.*image|create.*image|draw|paint|visualize)\b/i.test(userMessage);
  const looksComplexWorkflow = /\b(workflow|multi-step|single card demonstrates|pass markers|DEMO:|openclaw demo|research|analyze|analysis|benchmark|compare|competitive|market|investigate)\b/i.test(userMessage);
  let looksComplexByCard = false;

  if (cardId && !looksComplexWorkflow) {
    try {
      const trelloCfg = runtimeCfg?.plugins?.entries?.['openclaw-plugin-trello']?.config;
      const apiKey = trelloCfg?.auth?.apiKey;
      const token = trelloCfg?.auth?.token;
      if (apiKey && token) {
        const q = new URLSearchParams({ key: apiKey, token }).toString();
        const url = `https://api.trello.com/1/cards/${cardId}?fields=name,desc&${q}`;
        const res = await fetch(url);
        if (res.ok) {
          const card = await res.json() as { name?: string; desc?: string };
          const cardText = `${String(card?.name || '')}\n\n${String(card?.desc || '')}`;
          looksComplexByCard = /\b(openclaw demo|workflow|multi-step|single card demonstrates|pass markers|DEMO:|research|analyze|analysis|benchmark|compare|competitive|market|investigate)\b/i.test(cardText);
        }
      }
    } catch (_err) {
      // best-effort signal only
    }
  }

  const isComplexWorkflow = looksComplexWorkflow || looksComplexByCard;

  console.log(
    `[TrelloChannel][dispatch] cardId=${cardId || 'none'} ` +
    `flags={image:${wantsImage},pdf:${wantsPdf},complexMsg:${looksComplexWorkflow},complexCard:${looksComplexByCard},complex:${isComplexWorkflow}} ` +
    `snippet=${JSON.stringify(String(userMessage || '').slice(0, 180))}`
  );

  const systemPrompt = cardId && isComplexWorkflow
    ? `You are an AI assistant working on a Trello card (ID: ${cardId}).\n\n` +
      `The user is asking for a multi-step end-to-end Trello workflow demo, not a single artifact.\n` +
      `Prefer responding with JSON workflow operations (no prose) using:\n` +
      `{"type":"workflow","operations":[{"op":"assign_self"},{"op":"move_card","listName":"In Progress"}]}\n` +
      `Supported ops include: assign_self, create_card, move_card, set_dates, add_member, remove_member, set_members, add_label, remove_label, update_checklist_item, complete_checklist_item, add_comment, update_comment, attach_link, mark_complete, archive_card.\n` +
      `For label operations, if labels are color-only, pass labelColor (e.g. blue/green).\n` +
      `If rich outputs are requested, include attach_link plus comments describing generated image/PDF outputs so the plugin can complete demo verification.`
    : cardId && wantsImage
    ? `You are an AI assistant working on a Trello card (ID: ${cardId}).\n\n` +
      `The user wants you to generate an image and attach it to the Trello card.\n` +
      `Always include the finished post copy in a "copy" field.\n` +
      `If your skills/tools can generate an actual image artifact, respond ONLY with JSON (no prose) using one of these forms:\n` +
      `{"type":"image","filename":"<name-without-extension>","imageUrl":"<https-url-to-image>","copy":"<final post copy>"}\n` +
      `{"type":"image","filename":"<name-without-extension>","imageBase64":"<base64-or-data-url>","mimeType":"image/png","copy":"<final post copy>"}\n` +
      `{"type":"image","filename":"<name-without-extension>","imagePath":"</absolute/path/to/image/file>","mimeType":"image/png","copy":"<final post copy>"}\n` +
      `If you cannot produce a concrete image artifact, return fallback JSON:\n` +
      `{"type":"image","filename":"<name-without-extension>","prompt":"<detailed image generation prompt>","copy":"<final post copy>"}`
    : cardId && wantsPdf
    ? `You are an AI assistant working on a Trello card (ID: ${cardId}).\n\n` +
      `The user wants you to generate content AND attach it as a PDF to the Trello card.\n` +
      `Respond ONLY with a JSON object in this exact format (no other text):\n` +
      `{"type":"pdf","filename":"<descriptive-filename-without-extension>","content":"<full content to put in PDF>"}\n` +
      `The plugin will generate the PDF and attach it automatically.`
    : cardId
    ? `You are an AI assistant working on a Trello card (ID: ${cardId}). Answer the user's request helpfully.
If the user requests a multi-step Trello action plan, you may respond with JSON only using:
{"type":"workflow","operations":[{"op":"move_card","listName":"Done"}]}
Supported ops include: assign_self, create_card, move_card, set_dates, add_member, remove_member, set_members, add_label, remove_label, update_checklist_item, complete_checklist_item, add_comment, update_comment, attach_link, mark_complete, archive_card.
For update_checklist_item use checklistItemName to find the existing item and checklistItemNewName for the new title.`
    : undefined;

  const listInstructionSystemPrompt = listPromptInstructions
    ? `List-level operating instructions (from Prompt card):\n${listPromptInstructions}\n\nInterpret these as execution constraints for how work should be handled in this list. Do not treat them as the user's direct request. Answer the user's card request first. Only return workflow JSON when the user explicitly asks for Trello operations to be executed.`
    : undefined;

  const messages: any[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (listInstructionSystemPrompt) messages.push({ role: 'system', content: listInstructionSystemPrompt });
  messages.push({ role: 'user', content: userMessage });

  const envTimeoutMs = Number(process.env.TRELLO_AGENT_TIMEOUT_MS || 0);
  const defaultTimeoutMs = Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : 45_000;
  const imageTimeoutMs = Number(process.env.TRELLO_AGENT_TIMEOUT_IMAGE_MS || 180_000) || 180_000;
  const pdfTimeoutMs = Number(process.env.TRELLO_AGENT_TIMEOUT_PDF_MS || 120_000) || 120_000;
  const complexWorkflowTimeoutMs = Number(process.env.TRELLO_AGENT_TIMEOUT_COMPLEX_MS || 300_000) || 300_000;

  let requestTimeoutMs = wantsImage ? imageTimeoutMs : wantsPdf ? pdfTimeoutMs : defaultTimeoutMs;
  if (isComplexWorkflow) {
    requestTimeoutMs = Math.max(requestTimeoutMs, complexWorkflowTimeoutMs);
  }

  const isAbortError = (err: unknown): boolean => {
    const name = (err as any)?.name;
    const msg = String((err as any)?.message || err || '').toLowerCase();
    return name === 'AbortError' || msg.includes('aborted') || msg.includes('aborterror');
  };

  const maxAttempts = isComplexWorkflow ? 3 : 2;
  let response: Response | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const attemptTimeoutMs = attempt === 1 ? requestTimeoutMs : Math.min(requestTimeoutMs * 2, 600_000);
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);

    try {
      response = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GATEWAY_TOKEN,
          'Content-Type': 'application/json',
          'X-Openclaw-Agent': agentId,
        },
        body: JSON.stringify({
          model: 'openclaw/' + agentId,
          messages,
          stream: false,
          metadata: { sessionId },
        }),
        signal: controller.signal,
      });
      break;
    } catch (err) {
      lastError = err;
      if (!isAbortError(err) || attempt >= maxAttempts) {
        throw err;
      }
      webhookIngressMetrics.retried += 1;
      maybeLogWebhookIngressMetrics();
      console.warn(`[TrelloChannel] Agent dispatch attempt ${attempt} aborted; retrying with extended timeout.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!response) {
    trackDispatchError();
    throw new Error(`Gateway dispatch failed before response: ${String((lastError as any)?.message || lastError || 'unknown error')}`);
  }
  if (!response.ok) {
    trackDispatchError();
    const text = await response.text();
    throw new Error('Gateway dispatch failed: ' + response.status + ' ' + text);
  }
  const data = await response.json() as any;
  addUsageFromResponse(agentId, data);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    trackDispatchError();
    throw new Error('No response content from agent');
  }
  return content;
}

export function register(api: any) {
  if (_getInstance()) return _getInstance();

  const config = normalizePluginConfig(api.pluginConfig);
  const instance = new TrelloChannel(config);
  _setInstance(instance);

  const registerRoute = (method: string, path: string, handler: (req: any, res: any) => void) => {
    const key = method.toUpperCase() + ':' + path;
    _getRouteHandlers()[key] = handler;
  };

  if (api.registerHttpRoute) {
    api.registerHttpRoute({ method: 'POST', path: '/trello/webhook', auth: 'plugin', handler: async (rawReq: any, rawRes: any) => {
      if (rawReq.method === 'HEAD') {
        rawRes.statusCode = 200;
        rawRes.end();
        return;
      }
      const { req, res } = adaptReqRes(rawReq, rawRes);
      await readJsonBodyIntoReq(rawReq, req);

      const authValidation = validateWebhookAuth(req, config);
      if (!authValidation.ok) {
        console.warn(`[TrelloChannel] rejecting webhook auth: ${authValidation.reason || 'auth failed'}`);
        rawRes.statusCode = 401;
        rawRes.end();
        return;
      }

      const validation = validateWebhookPayloadForBoard(req.body);
      if (!validation.ok) {
        console.warn(`[TrelloChannel] rejecting webhook payload: ${validation.reason || 'validation failed'}`);
        rawRes.statusCode = 401;
        rawRes.end();
        return;
      }
      if (!instance.isBoardWatched(validation.boardId || '')) {
        console.warn(`[TrelloChannel] rejecting webhook payload: board mismatch payload=${validation.boardId || 'unknown'}`);
        rawRes.statusCode = 401;
        rawRes.end();
        return;
      }

      const webhookEventKey = buildWebhookEventKey(req.body);
      const ingressDecision = beginWebhookEvent(webhookEventKey);
      if (!ingressDecision.accepted) {
        console.log(`[TrelloChannel] webhook ${ingressDecision.reason || 'deduped'}; key=${webhookEventKey || 'none'}`);
        rawRes.statusCode = 202;
        rawRes.end();
        return;
      }

      const handler = _getRouteHandlers()['POST:/trello/webhook'];
      try {
        if (handler) {
          await handler(req, res);
        } else {
          rawRes.statusCode = 503;
          rawRes.end();
        }
      } finally {
        endWebhookEvent(webhookEventKey);
      }
    }});
    api.registerHttpRoute({ method: 'GET', path: '/trello/powerup/stats', auth: 'plugin', handler: async (rawReq: any, rawRes: any) => {
      const { req, res } = adaptReqRes(rawReq, rawRes);
      setPowerupCorsHeaders(rawReq, rawRes, 'GET,OPTIONS');

      if (String(rawReq?.method || '').toUpperCase() === 'OPTIONS') {
        rawRes.statusCode = 204;
        rawRes.end();
        return;
      }

      const expectedStatsToken = String(process.env.TRELLO_POWERUP_STATS_TOKEN || '').trim();
      if (expectedStatsToken) {
        const providedToken = String(req?.query?.token || getHeaderValue(req?.headers, 'x-stats-token') || '').trim();
        if (!providedToken || !safeCompareString(providedToken, expectedStatsToken)) {
          rawRes.statusCode = 401;
          rawRes.end();
          return;
        }
      }

      if (String(rawReq?.method || '').toUpperCase() !== 'GET') {
        rawRes.statusCode = 405;
        rawRes.end();
        return;
      }

      res.status(200).json(buildPowerupStatsPayload());
    }});
    api.registerHttpRoute({ method: 'GET', path: '/trello/powerup/board-members', auth: 'plugin', handler: async (rawReq: any, rawRes: any) => {
      const { req, res } = adaptReqRes(rawReq, rawRes);
      setPowerupCorsHeaders(rawReq, rawRes, 'GET,OPTIONS');

      const method = String(rawReq?.method || '').toUpperCase();
      if (method === 'OPTIONS') {
        rawRes.statusCode = 204;
        rawRes.end();
        return;
      }
      if (method !== 'GET') {
        rawRes.statusCode = 405;
        rawRes.end();
        return;
      }

      try {
        const result = await instance.listPowerupBoardMembers({
          boardId: req?.query?.boardId,
        });
        res.status(200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }});
    api.registerHttpRoute({ method: 'OPTIONS', path: '/trello/powerup/setup-card', auth: 'plugin', handler: async (rawReq: any, rawRes: any) => {
      const { req, res } = adaptReqRes(rawReq, rawRes);
      setPowerupCorsHeaders(rawReq, rawRes);

      const method = String(rawReq?.method || '').toUpperCase();
      if (method === 'OPTIONS') {
        rawRes.statusCode = 204;
        rawRes.end();
        return;
      }
      if (method !== 'POST') {
        rawRes.statusCode = 405;
        rawRes.end();
        return;
      }

      await readJsonBodyIntoReq(rawReq, req);
      try {
        const result = await instance.createPowerupSetupCard(req.body || {});
        res.status(200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }});
    api.registerHttpRoute({ method: 'OPTIONS', path: '/trello/powerup/setup-import', auth: 'plugin', handler: async (rawReq: any, rawRes: any) => {
      const { req, res } = adaptReqRes(rawReq, rawRes);
      setPowerupCorsHeaders(rawReq, rawRes);

      const method = String(rawReq?.method || '').toUpperCase();
      if (method === 'OPTIONS') {
        rawRes.statusCode = 204;
        rawRes.end();
        return;
      }
      if (method !== 'POST') {
        rawRes.statusCode = 405;
        rawRes.end();
        return;
      }

      await readJsonBodyIntoReq(rawReq, req);
      try {
        const result = await instance.importPowerupSetupCard(req.body || {});
        res.status(200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }});
    api.registerHttpRoute({ method: 'OPTIONS', path: '/trello/powerup/bootstrap-prompts', auth: 'plugin', handler: async (rawReq: any, rawRes: any) => {
      const { req, res } = adaptReqRes(rawReq, rawRes);
      setPowerupCorsHeaders(rawReq, rawRes);

      const method = String(rawReq?.method || '').toUpperCase();
      if (method === 'OPTIONS') {
        rawRes.statusCode = 204;
        rawRes.end();
        return;
      }
      if (method !== 'POST') {
        rawRes.statusCode = 405;
        rawRes.end();
        return;
      }

      await readJsonBodyIntoReq(rawReq, req);
      try {
        const result = await instance.bootstrapPowerupPromptCards(req.body || {});
        res.status(200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }});
  }

  if (api.registerTool) {
    if (config.auth.apiKey && config.auth.token) {
      const auth = new ApiKeyAuthProvider(config.auth);
      const client = new TrelloClient(auth);
      api.registerTool(createTrelloTools(client));
    }
  }

  const getBotMemberId = async () => '';

  setImmediate(() => {
    instance.initialize({
      registerRoute,
      dispatchToAgent: dispatchToOpenClawAgent,
      getBotMemberId,
    }).catch((err: Error) => console.error('[TrelloChannel] init error:', err));
  });

  return instance;
}

export const activate = register;

export class TrelloChannel {
  private client!: TrelloClient;
  private router!: TrelloAgentRouter;
  private store!: TrelloSessionStore;
  private webhookHandler!: TrelloWebhookHandler;
  private boardIds!: BoardIds;
  private primaryBoardId = '';
  private watchedBoardIds = new Set<string>();
  private webhookIds = new Set<string>();
  private boardIdsByBoardId = new Map<string, BoardIds>();
  private interimThresholdMs: number;
  private botMemberId = '';
  private shoppingPollTimer: NodeJS.Timeout | undefined;
  private shoppingPollInFlight = false;
  private backlogPollTimer: NodeJS.Timeout | undefined;
  private backlogPollInFlight = false;
  private backlogSeenCardIds = new Set<string>();
  private watchedListIdsByBoardId = new Map<string, Set<string>>();
  private watchCardNamePattern: RegExp | null = null;
  private processedShoppingCommentIds = new Set<string>();
  private readyCheckoutLabelIdsByBoardId = new Map<string, string>();
  private labelSignatureByCardId = new Map<string, string>();
  private lastRecoveryCheckAtByCardId = new Map<string, number>();
  private lastSeenListIdByCardId = new Map<string, string>();
  private lastProcessedListMoveActionByCardId = new Map<string, string>();
  private boardPowerupConfigCache = new Map<string, { expiresAt: number; config: any }>();
  private activeRoutedCards = new Set<string>();
  private lastRoutedFingerprintByCardId = new Map<string, { fingerprint: string; at: number }>();

  private readonly routedEventDedupWindowMs = 120_000;
  private readonly finalCommentDedupWindowMs = 600_000;

  private dispatchToAgent!: (agentId: string, message: string, sessionId: string, cardId?: string) => Promise<string>;

  constructor(private readonly config: TrelloPluginConfig) {
    this.interimThresholdMs = config.interimResponseThresholdMs ?? 30_000;
  }

  async initialize(gatewayContext: {
    registerRoute: (method: string, path: string, handler: (req: any, res: any) => void) => void;
    dispatchToAgent: (agentId: string, message: string, sessionId: string, cardId?: string) => Promise<string>;
    getBotMemberId: () => Promise<string>;
  }): Promise<void> {
    this.dispatchToAgent = gatewayContext.dispatchToAgent;

    if (!this.config.auth.apiKey || !this.config.auth.token || !this.config.webhookCallbackUrl) {
      console.warn('[TrelloChannel] missing required Trello config (auth/webhookCallbackUrl); channel startup skipped for this probe.');
      return;
    }

    const auth = new ApiKeyAuthProvider(this.config.auth);
    this.client = new TrelloClient(auth);
    this.router = new TrelloAgentRouter(this.config.agentLabels, this.config.defaultAgent);
    this.store = new TrelloSessionStore();

    const boardIdsToWatch = await this.resolveBoardIdsToWatch();
    if (!boardIdsToWatch.length) {
      console.warn('[TrelloChannel] no accessible Trello boards were resolved; channel startup skipped for this probe.');
      return;
    }

    this.watchedBoardIds = new Set(boardIdsToWatch);
    this.primaryBoardId = boardIdsToWatch[0];

    const primaryBoard = await this.client.getBoard(this.primaryBoardId);
    console.log(`[TrelloChannel] Connected to board: "${primaryBoard.name}"`);

    for (const boardId of boardIdsToWatch) {
      const resolved = await this.resolveBoardIdsFromExistingState(boardId);
      this.boardIdsByBoardId.set(boardId, resolved);
      await this.initializeWatchFilters(boardId, resolved);
    }
    this.boardIds = this.boardIdsByBoardId.get(this.primaryBoardId) as BoardIds;

    let botMemberId = await gatewayContext.getBotMemberId();
    if (!botMemberId) {
      try {
        const me = await this.client.getMe();
        botMemberId = me?.id ?? '';
        console.log(`[TrelloChannel] Bot member ID resolved: ${botMemberId} (@${me?.username})`);
      } catch (e) {
        console.warn('[TrelloChannel] Could not resolve bot member ID:', e);
      }
    }
    this.botMemberId = botMemberId;

    this.webhookHandler = new TrelloWebhookHandler({
      router: this.router,
      store: this.store,
      client: this.client,
      botMemberId,
      isAutomationMember: async (boardId: string, memberId: string) => {
        const targetBoardId = String(boardId || '').trim() || this.getPrimaryBoardId();
        const automationIds = await this.getConfiguredAutomationMemberIds(targetBoardId);
        return automationIds.has(String(memberId || '').trim());
      },
      onRoutedEvent: (event) => this.handleRoutedEvent(event),
      onChecklistItemAdded: (event) => this.handleChecklistItemAdded(event),
      onShoppingComment: (event) => this.handleShoppingComment(event),
    });

    gatewayContext.registerRoute('POST', '/trello/webhook', (req, res) =>
      this.webhookHandler.handle(req, res),
    );
    gatewayContext.registerRoute('HEAD', '/trello/webhook', (req, res) =>
      this.webhookHandler.handle(req, res),
    );

    for (const boardId of boardIdsToWatch) {
      const webhook = await this.client.registerOrReuseWebhook(
        this.config.webhookCallbackUrl,
        boardId,
      );
      this.webhookIds.add(webhook.id);
    }

    await this.primeBacklogPollSeen();
    this.startBacklogPoller();
    this.startShoppingPoller();
    await this.ensureCheckoutLabelForCurrentState();

    const webhookSummary = Array.from(this.webhookIds).join(',');
    if (boardIdsToWatch.length === 1) {
      console.log(`[TrelloChannel] Ready. Watching board: "${primaryBoard.name}" (webhook: ${webhookSummary})`);
    } else {
      console.log(`[TrelloChannel] Ready. Watching ${boardIdsToWatch.length} boards (primary: "${primaryBoard.name}") (webhooks: ${webhookSummary})`);
    }
  }

  isBoardWatched(boardId: string): boolean {
    const normalized = String(boardId || '').trim();
    if (!normalized) return false;
    return this.watchedBoardIds.has(normalized);
  }

  private async resolveBoardIdsToWatch(): Promise<string[]> {
    const configuredBoardId = String(this.config.boardId || '').trim();
    if (configuredBoardId && configuredBoardId !== '*') {
      return [configuredBoardId];
    }

    const boards = await this.client.getMemberBoards();
    return boards
      .filter(board => !board.closed)
      .map(board => String(board.id || '').trim())
      .filter(Boolean);
  }

  private async resolveBoardIdsFromExistingState(boardId: string): Promise<BoardIds> {
    const lists = await this.client.getLists(boardId);

    const byName = new Map(lists.map(list => [String(list.name || '').trim().toLowerCase(), list.id]));
    const configuredBacklog = byName.get(String(this.config.lists?.backlog || '').trim().toLowerCase());
    const configuredInProgress = byName.get(String(this.config.lists?.inProgress || '').trim().toLowerCase());
    const configuredDone = byName.get(String(this.config.lists?.done || '').trim().toLowerCase());

    if (!configuredBacklog) {
      console.warn(`[TrelloChannel] Missing configured list "${this.config.lists?.backlog}" for backlog; using existing board lists only.`);
    }
    if (!configuredInProgress) {
      console.warn(`[TrelloChannel] Missing configured list "${this.config.lists?.inProgress}" for inProgress; cards will stay in their current list unless explicitly moved.`);
    }
    if (!configuredDone) {
      console.warn(`[TrelloChannel] Missing configured list "${this.config.lists?.done}" for done; completion move will fall back to current list.`);
    }

    const backlogListId = configuredBacklog || lists[0]?.id || '';
    const doneListId = configuredDone || configuredInProgress || backlogListId;

    return {
      backlogListId,
      inProgressListId: configuredInProgress,
      doneListId,
      labelColorToId: {},
    } as BoardIds;
  }

  async destroy(): Promise<void> {
    if (this.backlogPollTimer) {
      clearInterval(this.backlogPollTimer);
      this.backlogPollTimer = undefined;
    }
    if (this.shoppingPollTimer) {
      clearInterval(this.shoppingPollTimer);
      this.shoppingPollTimer = undefined;
    }
    for (const webhookId of this.webhookIds) {
      await this.client.deleteWebhook(webhookId);
    }
    if (this.webhookIds.size > 0) {
      console.log('[TrelloChannel] Webhook deregistered.');
      this.webhookIds.clear();
    }
  }

  private startShoppingPoller(): void {
    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return;

    const pollIntervalMs = Math.max(5000, automation.targetWeb.pollIntervalMs ?? 15000);
    if (this.shoppingPollTimer) clearInterval(this.shoppingPollTimer);

    this.shoppingPollTimer = setInterval(() => {
      this.processShoppingPollTick().catch(err => {
        console.error('[TrelloChannel] Shopping poll tick failed:', err);
      });
    }, pollIntervalMs);
  }

  private async initializeWatchFilters(boardId: string, resolvedBoardIds: BoardIds): Promise<void> {
    const lists = await this.client.getLists(boardId);
    const listIdByName = new Map(lists.map(list => [list.name.trim().toLowerCase(), list.id]));

    const configured = (process.env.TRELLO_WATCH_LIST_NAMES || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
    const namesToWatch = configured.length
      ? configured
      : lists.map(list => list.name);

    const watchedListIds = new Set<string>();
    for (const listName of namesToWatch) {
      const listId = listIdByName.get(listName.toLowerCase());
      if (listId) watchedListIds.add(listId);
    }
    if (watchedListIds.size === 0) {
      if (resolvedBoardIds.backlogListId) {
        watchedListIds.add(resolvedBoardIds.backlogListId);
      }
    }
    this.watchedListIdsByBoardId.set(boardId, watchedListIds);

    const rawPattern = (process.env.TRELLO_WATCH_CARD_NAME_REGEX || '').trim();
    if (!rawPattern) {
      this.watchCardNamePattern = null;
      return;
    }

    try {
      this.watchCardNamePattern = new RegExp(rawPattern, 'i');
    } catch (err) {
      console.warn(`[TrelloChannel] Invalid TRELLO_WATCH_CARD_NAME_REGEX (${rawPattern}); ignoring filter.`, err);
      this.watchCardNamePattern = null;
    }
  }

  private async primeBacklogPollSeen(): Promise<void> {
    for (const boardId of this.watchedBoardIds) {
      const watchedListIds = this.watchedListIdsByBoardId.get(boardId) || new Set<string>();
      const cards = await this.client.getBoardCards(boardId);
      for (const card of cards) {
        this.lastSeenListIdByCardId.set(card.id, card.idList);
        if (watchedListIds.has(card.idList)) {
          this.backlogSeenCardIds.add(card.id);
        }
      }
    }
  }

  private startBacklogPoller(): void {
    const pollIntervalMs = Math.max(5000, Number(process.env.TRELLO_BACKLOG_POLL_INTERVAL_MS || 10000));
    if (this.backlogPollTimer) clearInterval(this.backlogPollTimer);

    this.processBacklogPollTick().catch(err => {
      console.error('[TrelloChannel] Backlog initial poll failed:', err);
    });

    this.backlogPollTimer = setInterval(() => {
      this.processBacklogPollTick().catch(err => {
        console.error('[TrelloChannel] Backlog poll tick failed:', err);
      });
    }, pollIntervalMs);
  }

  private async processBacklogPollTick(): Promise<void> {
    if (this.backlogPollInFlight) return;
    this.backlogPollInFlight = true;
    try {
      for (const boardId of this.watchedBoardIds) {
      const cards = await this.client.getBoardCards(boardId);
      const watchedListIds = this.watchedListIdsByBoardId.get(boardId) || new Set<string>();
      const movedBacklogCards: Array<{ id: string; name: string; idList: string }> = [];

      for (const card of cards) {
        const previousListId = this.lastSeenListIdByCardId.get(card.id);
        this.lastSeenListIdByCardId.set(card.id, card.idList);

        if (!previousListId || previousListId === card.idList) continue;
        if (!watchedListIds.has(card.idList)) continue;

        // Re-open intake eligibility when a card is moved to another watched list.
        this.lastRecoveryCheckAtByCardId.delete(card.id);
        movedBacklogCards.push(card);
      }

      // Detect label edits on any existing card and remap list accordingly.
      for (const boardCard of cards) {
        let fullCard: any;
        try {
          fullCard = await this.client.getCard(boardCard.id);
        } catch (err) {
          console.error(`[TrelloChannel] Failed to fetch card ${boardCard.id} for label-change scan:`, err);
          continue;
        }

        const nextSignature = this.computeLabelSignature(fullCard);
        const prevSignature = this.labelSignatureByCardId.get(boardCard.id);
        this.labelSignatureByCardId.set(boardCard.id, nextSignature);

        if (prevSignature !== nextSignature && !this.isPromptInstructionCard(fullCard)) {
          await this.moveCardToListMappedByLabel(boardCard.id, boardId);
        }
      }

      const backlogCards = cards
        .filter(card => watchedListIds.has(card.idList))
        .filter(card => !this.watchCardNamePattern || this.watchCardNamePattern.test(card.name));

        const newBacklogCards = backlogCards.filter(card => !this.backlogSeenCardIds.has(card.id));
        const recoveryBacklogCards: Array<{ id: string; name: string; idList: string }> = [];
        const now = Date.now();
        for (const card of backlogCards) {
          if (!this.backlogSeenCardIds.has(card.id)) continue;
          if (this.store.get(card.id)) continue;

          const movedIntoWatchedList = await this.hasUnprocessedMoveIntoList(card.id, card.idList);
          if (movedIntoWatchedList) {
            recoveryBacklogCards.push(card);
            continue;
          }

          const lastRecoveryCheckAt = this.lastRecoveryCheckAtByCardId.get(card.id) || 0;
          if ((now - lastRecoveryCheckAt) < BACKLOG_RECOVERY_RECHECK_MS) continue;
          this.lastRecoveryCheckAtByCardId.set(card.id, now);
          try {
            const shouldRecover = await this.shouldRecoverSeenBacklogCard(card.id);
            if (shouldRecover) recoveryBacklogCards.push(card);
          } catch (err) {
            console.error(`[TrelloChannel] Recovery check failed for card ${card.id}:`, err);
          }
        }

        const candidateBacklogCards = [...newBacklogCards, ...recoveryBacklogCards, ...movedBacklogCards]
          .filter((card, idx, arr) => arr.findIndex(other => other.id === card.id) === idx);

        for (const card of candidateBacklogCards) {
        this.backlogSeenCardIds.add(card.id);

        if (this.store.get(card.id)) continue;
        if (this.config.shoppingAutomation?.enabled && this.matchesConfiguredValue(card.name, this.config.shoppingAutomation.cardName)) {
          continue;
        }

        let fullCard: any;
        try {
          fullCard = await this.client.getCard(card.id);
        } catch (err) {
          console.error(`[TrelloChannel] Failed to fetch backlog card ${card.id}:`, err);
          continue;
        }

        // Cards labeled "Prompt" act as list-level instruction cards, not executable work items.
        if (this.isPromptInstructionCard(fullCard)) {
          continue;
        }

        if (await this.isReadOnlyLinkCard(card.id, fullCard)) {
          continue;
        }

        const agentId = this.router.resolve(fullCard.labels ?? []);
        if (!agentId) {
          try {
            await this.client.addComment(
              card.id,
              '⚠️ No agent assigned. Configure agentLabels in the plugin config to route cards by label, or set a defaultAgent.'
            );
          } catch (err) {
            console.error('[TrelloChannel] Failed to post unassigned-agent comment:', err);
          }
          continue;
        }

        const title = fullCard?.name ?? card.name ?? '';
        const desc = (fullCard?.desc ?? '').trim();
        const baseText = desc ? `${title}\n\n${desc}` : title;
        const listId = String(fullCard?.idList || card.idList || '');
        const promptInstructions = listId
          ? await this.getPromptInstructionsForList(boardId, listId, card.id)
          : undefined;
        const hasManualAssignment = await this.hasManualAutomationMemberAssignment(fullCard, boardId);
        if (!promptInstructions && !hasManualAssignment) {
          continue;
        }
        const text = promptInstructions
          ? `${baseText}\n\nList Instructions (from Prompt card, MANDATORY):\n${promptInstructions}\n\nApply these instructions directly. Do not ask the user to repeat or paste them.`
          : baseText;
        if (!text) continue;

        const session = this.store.create(card.id, agentId);
        await this.handleRoutedEvent({
          cardId: card.id,
          agentId,
          text,
          isFollowUp: false,
          session,
        });
      }
      }
    } finally {
      this.backlogPollInFlight = false;
    }
  }

  private isPromptInstructionCard(card: any): boolean {
    const labels = Array.isArray(card?.labels) ? card.labels : [];
    return labels.some((label: any) => String(label?.name || '').trim().toLowerCase() === 'prompt');
  }

  private computeLabelSignature(card: any): string {
    const labels = Array.isArray(card?.labels) ? card.labels : [];
    const labelTokens: string[] = labels
      .map((label: any) => String(label?.id || label?.name || label?.color || '').trim().toLowerCase())
      .filter(Boolean);
    if (Array.isArray(card?.idLabels)) {
      for (const labelId of card.idLabels) {
        const token = String(labelId || '').trim().toLowerCase();
        if (token) labelTokens.push(token);
      }
    }

    return labelTokens
      .filter(Boolean)
      .sort()
      .join('|');
  }

  private async getPromptInstructionsForList(boardId: string, listId: string, excludeCardId: string): Promise<string | undefined> {
    let cards: Array<{ id: string; name: string; idList: string }> = [];
    try {
      cards = await this.client.getBoardCards(boardId);
    } catch (err) {
      console.error('[TrelloChannel] Failed to fetch board cards for Prompt instructions:', err);
      return undefined;
    }

    const sameListCards = cards.filter(card => card.idList === listId && card.id !== excludeCardId);
    for (const candidate of sameListCards) {
      try {
        const full = await this.client.getCard(candidate.id);
        if (!this.isPromptInstructionCard(full)) continue;

        const title = String(full?.name || '').trim();
        const desc = String(full?.desc || '').trim();
        const instructionText = [title, desc].filter(Boolean).join('\n\n').trim();
        if (instructionText) return instructionText;
      } catch (err) {
        console.error(`[TrelloChannel] Failed to fetch Prompt card candidate ${candidate.id}:`, err);
      }
    }

    return undefined;
  }

  private async hasManualAutomationMemberAssignment(card: any, boardId: string): Promise<boolean> {
    const configuredAutomationIds = await this.getConfiguredAutomationMemberIds(boardId);
    if (!configuredAutomationIds.size) return false;

    const cardMemberIds = Array.isArray((card as any)?.idMembers)
      ? ((card as any).idMembers as unknown[]).map(memberId => String(memberId || '').trim()).filter(Boolean)
      : [];
    if (!cardMemberIds.length) return false;

    return cardMemberIds.some(memberId => configuredAutomationIds.has(memberId));
  }

  private async hasUnprocessedMoveIntoList(cardId: string, targetListId: string): Promise<boolean> {
    try {
      const latestMove = await this.client.getLatestCardListMoveAction(cardId);
      if (!latestMove?.id) return false;

      const movedIntoListId = String(latestMove.data?.listAfter?.id || '').trim();
      if (!movedIntoListId || movedIntoListId !== String(targetListId || '').trim()) return false;

      const lastProcessedActionId = this.lastProcessedListMoveActionByCardId.get(cardId);
      if (lastProcessedActionId && lastProcessedActionId === latestMove.id) return false;

      this.lastProcessedListMoveActionByCardId.set(cardId, latestMove.id);
      return true;
    } catch (err) {
      console.error(`[TrelloChannel] Failed move-action check for card ${cardId}:`, err);
      return false;
    }
  }

  private async shouldRecoverSeenBacklogCard(cardId: string): Promise<boolean> {
    const fullCard = await this.client.getCard(cardId);
    if (this.isPromptInstructionCard(fullCard)) return false;

    const comments = await this.client.getCardComments(cardId, 30);
    const hasBotComment = comments.some((action: any) => {
      const creatorId = String(action?.memberCreator?.id || '').trim();
      return !!this.botMemberId && creatorId === this.botMemberId;
    });
    if (hasBotComment) return false;

    const desc = String(fullCard?.desc || '');
    if (/## Research Output/i.test(desc)) return false;

    return true;
  }

  private async processShoppingPollTick(): Promise<void> {
    if (this.shoppingPollInFlight) return;

    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return;

    this.shoppingPollInFlight = true;
    try {
      const cards = await this.client.getBoardCards(this.getPrimaryBoardId());
      const card = cards.find(c => this.matchesConfiguredValue(c.name, automation.cardName));
      if (!card) return;

      const checklists = await this.client.getCardChecklists(card.id);
      const checklist = this.selectTargetChecklist(checklists, automation.checklistName);
      if (!checklist) return;

      const minimumSubtotal = automation.minimumSubtotal ?? 35;
      const activeItems = (checklist.checkItems || []).filter(item => item.state !== 'complete');
      const subtotal = activeItems.reduce((sum, item) => {
        const parsed = this.parseLineTotalFromName(item.name).lineTotal;
        return sum + (parsed ?? 0);
      }, 0);
      if (subtotal >= minimumSubtotal) {
        await this.ensureReadyCheckoutLabel(card.id);
      }

      const handledCommentChange = await this.processPendingShoppingChangeComment(card.id, card.name);
      if (handledCommentChange) return;

      const unpriced = activeItems.filter(item => {
        if (item.state === 'complete') return false;
        return this.parseLineTotalFromName(item.name).lineTotal === undefined;
      });
      const firstUnpriced = unpriced.length ? unpriced[unpriced.length - 1] : undefined;
      if (!firstUnpriced) return;

      await this.handleChecklistItemAdded({
        cardId: card.id,
        cardName: card.name,
        checklistId: checklist.id,
        checklistName: checklist.name,
        checkItemId: firstUnpriced.id,
        checkItemName: firstUnpriced.name,
      });
    } finally {
      this.shoppingPollInFlight = false;
    }
  }

  private async ensureCheckoutLabelForCurrentState(): Promise<void> {
    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return;

    const cards = await this.client.getBoardCards(this.getPrimaryBoardId());
    const card = cards.find(c => this.matchesConfiguredValue(c.name, automation.cardName));
    if (!card) return;

    const checklists = await this.client.getCardChecklists(card.id);
    const checklist = this.selectTargetChecklist(checklists, automation.checklistName);
    if (!checklist) return;

    const activeItems = (checklist.checkItems || []).filter(item => item.state !== 'complete');
    const subtotal = activeItems.reduce((sum, item) => {
      const parsed = this.parseLineTotalFromName(item.name).lineTotal;
      return sum + (parsed ?? 0);
    }, 0);
    const minimumSubtotal = automation.minimumSubtotal ?? 35;
    if (subtotal >= minimumSubtotal) {
      await this.ensureReadyCheckoutLabel(card.id);
    }
  }

  async notify(agentId: string, title: string, body: string): Promise<void> {
    const boardIds = this.boardIdsByBoardId.get(this.getPrimaryBoardId()) || this.boardIds;
    const agentLabelColor = this.getLabelColorForAgent(agentId);
    const labelIds: string[] = [];

    if (agentLabelColor) {
      const labelId = boardIds.labelColorToId[agentLabelColor];
      if (labelId) {
        labelIds.push(labelId);
      }
    }

    const card = await this.client.createCard({
      idList: boardIds.backlogListId,
      name: title,
      desc: body,
      labelIds,
    });

    await this.client.moveCard(card.id, boardIds.doneListId);
  }

  private async handleChecklistItemAdded(event: ChecklistItemAddedEvent): Promise<void> {
    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return;
    if (!event.checkItemId) return;

    if (!this.matchesConfiguredValue(event.cardName, automation.cardName)) return;
    if (automation.checklistName && event.checklistName && !this.matchesConfiguredValue(event.checklistName, automation.checklistName)) {
      return;
    }

    try {
      if (this.botMemberId) {
        try {
          await this.client.addMember(event.cardId, this.botMemberId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.toLowerCase().includes('already on the card')) {
            console.error(`[TrelloChannel] Failed to assign bot to card ${event.cardId}:`, err);
          }
        }
      }

      const checklists = await this.client.getCardChecklists(event.cardId);
      const targetChecklist = this.selectTargetChecklist(checklists, automation.checklistName, event.checklistId);
      if (!targetChecklist) return;

      const activeItems = (targetChecklist.checkItems ?? []).filter(item => item.state !== 'complete');
      if (!activeItems.length) return;

      const targetItem = activeItems.find(item => item.id === event.checkItemId)
        ?? activeItems.find(item => this.matchesConfiguredValue(item.name, event.checkItemName));
      if (!targetItem) return;

      const addedItemDetails = await this.ensureItemPriced(event.cardId, targetItem.id, targetItem.name, automation);

      const subtotal = activeItems.reduce((sum, item) => {
        if (item.id === targetItem.id) return sum + addedItemDetails.lineTotal;
        const parsed = this.parseLineTotalFromName(item.name).lineTotal;
        return sum + (parsed ?? 0);
      }, 0);

      const minimumSubtotal = automation.minimumSubtotal ?? 35;
      const missing = Math.max(0, minimumSubtotal - subtotal);

      const addedLine = addedItemDetails
        ? `Priced "${addedItemDetails.baseName}": $${addedItemDetails.lineTotal.toFixed(2)}${addedItemDetails.productUrl ? ` (${addedItemDetails.productUrl})` : ''}`
        : `Priced newly added checklist item: "${event.checkItemName}"`;

      await this.client.addComment(
        event.cardId,
        `${addedLine}\nRunning subtotal: $${subtotal.toFixed(2)} / $${minimumSubtotal.toFixed(2)}${missing > 0 ? ` (need $${missing.toFixed(2)} more)` : ' (threshold met)'}`,
      );

      if (subtotal >= minimumSubtotal) {
        await this.ensureReadyCheckoutLabel(event.cardId);
      }

      if (subtotal >= minimumSubtotal && !(await this.isThresholdAlreadyRecorded(event.cardId))) {
        await this.client.addComment(
          event.cardId,
          `Target free-shipping threshold reached at $${subtotal.toFixed(2)}. Ready for checkout demo. ${THRESHOLD_MARKER}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[TrelloChannel] Shopping automation failed:', err);
      await this.client.addComment(event.cardId, `Shopping automation error: ${message}`);
    }
  }

  private async handleShoppingComment(event: ShoppingCommentEvent): Promise<boolean> {
    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return false;
    if (!this.matchesConfiguredValue(event.cardName, automation.cardName)) return false;

    const command = this.parseShoppingChangeCommand(event.text);
    if (!command) return false;

    return this.applyShoppingChange(event.cardId, command);
  }

  private async processPendingShoppingChangeComment(cardId: string, cardName: string): Promise<boolean> {
    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return false;
    if (!this.matchesConfiguredValue(cardName, automation.cardName)) return false;

    const comments = await this.client.getCardComments(cardId, 40);
    for (const comment of comments) {
      const commentId = comment.id;
      if (!commentId || this.processedShoppingCommentIds.has(commentId)) continue;

      const text = comment.data?.text ?? '';
      const command = this.parseShoppingChangeCommand(text);
      if (!command) continue;

      const handled = await this.applyShoppingChange(cardId, command, commentId);
      this.processedShoppingCommentIds.add(commentId);
      if (handled) return true;
    }

    return false;
  }

  private async applyShoppingChange(
    cardId: string,
    command: { itemTerm: string; replacement: string; priceOverride?: number },
    commandCommentId?: string,
  ): Promise<boolean> {
    const automation = this.config.shoppingAutomation;
    if (!automation?.enabled || !automation.targetWeb?.enabled) return false;

    const checklists = await this.client.getCardChecklists(cardId);
    const targetChecklist = this.selectTargetChecklist(checklists, automation.checklistName);
    if (!targetChecklist) return false;

    const activeItems = (targetChecklist.checkItems ?? []).filter(item => item.state !== 'complete');
    const match = activeItems.find(item => this.matchesShoppingItem(item.name, command.itemTerm));
    if (!match) {
      await this.client.addComment(cardId, `Shopping automation note: Could not find checklist item matching "${command.itemTerm}".`);
      return true;
    }

    const updatedBaseName = `${command.itemTerm} ${command.replacement}`.replace(/\s+/g, ' ').trim();

    let lineTotal: number;
    let productUrl: string | undefined;
    if (command.priceOverride !== undefined) {
      lineTotal = command.priceOverride;
    } else {
      const priced = await this.lookupTargetPrice(updatedBaseName, 1, cardId, automation);
      lineTotal = priced.lineTotal;
      productUrl = priced.productUrl;
    }

    const updatedName = this.formatPricedName(updatedBaseName, lineTotal);
    await this.client.updateChecklistItemName(cardId, match.id, updatedName);

    const refreshed = await this.client.getCardChecklists(cardId);
    const refreshedChecklist = this.selectTargetChecklist(refreshed, automation.checklistName);
    const subtotal = (refreshedChecklist?.checkItems ?? [])
      .filter(item => item.state !== 'complete')
      .reduce((sum, item) => sum + (this.parseLineTotalFromName(item.name).lineTotal ?? 0), 0);

    const minimumSubtotal = automation.minimumSubtotal ?? 35;
    const missing = Math.max(0, minimumSubtotal - subtotal);
    const marker = commandCommentId ? ` #shopping-change-${commandCommentId}` : '';
    await this.client.addComment(
      cardId,
      `Updated "${command.itemTerm}" to "${updatedBaseName}": $${lineTotal.toFixed(2)}${productUrl ? ` (${productUrl})` : ''}` +
      `\nRunning subtotal: $${subtotal.toFixed(2)} / $${minimumSubtotal.toFixed(2)}${missing > 0 ? ` (need $${missing.toFixed(2)} more)` : ' (threshold met)'}${marker}`,
    );

    if (subtotal >= minimumSubtotal) {
      await this.ensureReadyCheckoutLabel(cardId);
    }

    return true;
  }

  private async ensureReadyCheckoutLabel(cardId: string): Promise<void> {
    const boardId = await this.resolveCardBoardId(cardId) || this.getPrimaryBoardId();
    const labelId = await this.getOrCreateReadyCheckoutLabelId(boardId);
    if (!labelId) return;

    const card = await this.client.getCard(cardId);
    if (Array.isArray(card.idLabels) && card.idLabels.includes(labelId)) return;

    await this.client.addLabel(cardId, labelId);
  }

  private async getOrCreateReadyCheckoutLabelId(boardId: string): Promise<string | undefined> {
    const normalizedBoardId = String(boardId || '').trim();
    if (!normalizedBoardId) return undefined;

    const cached = this.readyCheckoutLabelIdsByBoardId.get(normalizedBoardId);
    if (cached) return cached;

    const labels = await this.client.getLabels(normalizedBoardId);
    const byName = labels.find(label => this.matchesConfiguredValue(label.name || '', READY_CHECKOUT_LABEL_NAME));
    if (byName?.id) {
      this.readyCheckoutLabelIdsByBoardId.set(normalizedBoardId, byName.id);
      return byName.id;
    }

    const byGreen = labels.find(label => label.color === 'green');
    if (byGreen?.id) {
      this.readyCheckoutLabelIdsByBoardId.set(normalizedBoardId, byGreen.id);
      return byGreen.id;
    }

    const created = await this.client.createLabel(normalizedBoardId, READY_CHECKOUT_LABEL_NAME, 'green');
    this.readyCheckoutLabelIdsByBoardId.set(normalizedBoardId, created.id);
    return created.id;
  }

  private async ensureItemPriced(
    cardId: string,
    checkItemId: string,
    rawName: string,
    automation: TrelloShoppingAutomationConfig,
  ): Promise<PricedChecklistItem> {
    const parsedExisting = this.parseLineTotalFromName(rawName);
    const quantityData = this.parseQuantityAndBaseName(parsedExisting.baseName);

    if (parsedExisting.lineTotal !== undefined) {
      return {
        checkItemId,
        baseName: quantityData.baseName,
        quantity: quantityData.quantity,
        lineTotal: parsedExisting.lineTotal,
      };
    }

    const priced = await this.lookupTargetPrice(quantityData.baseName, quantityData.quantity, cardId, automation);
    const updatedName = this.formatPricedName(quantityData.originalName, priced.lineTotal);
    await this.client.updateChecklistItemName(cardId, checkItemId, updatedName);

    return {
      checkItemId,
      baseName: quantityData.baseName,
      quantity: quantityData.quantity,
      lineTotal: priced.lineTotal,
      unitPrice: priced.unitPrice,
      productTitle: priced.productTitle,
      productUrl: priced.productUrl,
    };
  }

  private async lookupTargetPrice(
    baseName: string,
    quantity: number,
    cardId: string,
    automation: TrelloShoppingAutomationConfig,
  ): Promise<{ lineTotal: number; unitPrice: number; productTitle?: string; productUrl?: string }> {
    const agentId = automation.targetWeb.pricingAgentId || this.config.defaultAgent || 'ironiclawy';
    const strictPrompt = [
      'Find a likely current price for this shopping list item on target.com.',
      `Item: ${baseName}`,
      `Quantity: ${quantity}`,
      'Rules:',
      '- Use browser/navigation tools and search target.com only.',
      '- Choose one realistic in-stock product match (closest common size/brand).',
      '- Open the product page and extract current price shown on page.',
      '- Return only JSON with this exact schema:',
      '{"unitPrice":number,"productTitle":"string","productUrl":"https://www.target.com/...","confidence":"high|medium|low"}',
      '- unitPrice must be a plain number in USD (e.g. 4.99).',
      '- productUrl must be a product detail page URL, not search results.',
      '- Do not include markdown fences or extra text.',
    ].join('\n');

    const fallbackPrompt = [
      'Return an estimated US retail price for this shopping list item.',
      `Item: ${baseName}`,
      `Quantity: ${quantity}`,
      'If live browsing is unavailable, provide a realistic estimate.',
      'Prefer target.com-style product naming when possible.',
      'Return only JSON with this exact schema:',
      '{"unitPrice":number,"productTitle":"string","productUrl":"string","confidence":"high|medium|low"}',
      '- No markdown, no prose.',
    ].join('\n');

    let response: string;
    try {
      response = await this.dispatchToAgent(agentId, strictPrompt, `target-pricing-${cardId}`, cardId);
    } catch (_err) {
      response = await this.dispatchToAgent(agentId, fallbackPrompt, `target-pricing-fallback-${cardId}`, cardId);
    }
    const parsed = this.parseJsonObject(response);

    const unitPrice = this.normalizePrice(parsed?.unitPrice);
    if (unitPrice === undefined) {
      throw new Error(`Target price lookup failed for "${baseName}": missing unitPrice in agent response`);
    }

    const lineTotal = unitPrice * quantity;
    return {
      unitPrice,
      lineTotal,
      productTitle: typeof parsed?.productTitle === 'string' ? parsed.productTitle : undefined,
      productUrl: typeof parsed?.productUrl === 'string' ? parsed.productUrl : undefined,
    };
  }

  private parseJsonObject(text: string): any {
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed);
    } catch (_err) {
      const fromFence = trimmed.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      try {
        return JSON.parse(fromFence);
      } catch (__err) {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
          return JSON.parse(trimmed.slice(start, end + 1));
        }
      }
    }
    throw new Error('Could not parse JSON object from pricing response');
  }

  private parseLineTotalFromName(name: string): { baseName: string; lineTotal?: number } {
    const trimmed = name.trim();
    const match = trimmed.match(/^(.*?)(?:\s+-\s+|\s+\()\$(\d+(?:\.\d{1,2})?)\)?$/);
    if (!match) return { baseName: trimmed };
    return {
      baseName: match[1].trim(),
      lineTotal: Number.parseFloat(match[2]),
    };
  }

  private formatPricedName(originalName: string, lineTotal: number): string {
    const withoutPrice = this.parseLineTotalFromName(originalName).baseName;
    return `${withoutPrice} - $${lineTotal.toFixed(2)}`;
  }

  private parseQuantityAndBaseName(name: string): { quantity: number; baseName: string; originalName: string } {
    const trimmed = name.trim();

    const leading = trimmed.match(/^(\d+(?:\.\d+)?)\s*[xX]\s+(.+)$/);
    if (leading) {
      return {
        quantity: Number(leading[1]),
        baseName: leading[2].trim(),
        originalName: trimmed,
      };
    }

    const trailing = trimmed.match(/^(.+?)\s*[xX]\s*(\d+(?:\.\d+)?)$/);
    if (trailing) {
      return {
        quantity: Number(trailing[2]),
        baseName: trailing[1].trim(),
        originalName: trimmed,
      };
    }

    return {
      quantity: 1,
      baseName: trimmed,
      originalName: trimmed,
    };
  }

  private normalizePrice(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (typeof value === 'string') {
      const stripped = value.replace(/[^0-9.\-]/g, '');
      if (!stripped) return undefined;
      const parsed = Number.parseFloat(stripped);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private parseShoppingChangeCommand(text: string): { itemTerm: string; replacement: string; priceOverride?: number } | undefined {
    if (!text) return undefined;

    const match = text.match(/\b(?:change|update|swap|replace)\s+(?:the\s+)?(.+?)\s+to\s+(.+)/i);
    if (!match) return undefined;

    const itemTerm = match[1].replace(/["']/g, '').trim();
    const replacement = match[2].replace(/["']/g, '').trim();
    if (!itemTerm || !replacement) return undefined;

    const priceMatch = text.match(/\$(\d+(?:\.\d{1,2})?)/);
    const parsedPrice = priceMatch ? Number.parseFloat(priceMatch[1]) : undefined;

    return {
      itemTerm,
      replacement,
      priceOverride: Number.isFinite(parsedPrice ?? NaN) ? parsedPrice : undefined,
    };
  }

  private matchesShoppingItem(itemName: string, itemTerm: string): boolean {
    const base = this.parseLineTotalFromName(itemName).baseName.toLowerCase();
    const term = itemTerm.toLowerCase();
    return base.includes(term) || term.includes(base);
  }

  private getPrimaryBoardId(): string {
    const configured = String(this.config.boardId || '').trim();
    if (configured && configured !== '*') return configured;
    return this.primaryBoardId;
  }

  private async resolveCardBoardId(cardId: string): Promise<string | undefined> {
    try {
      const card = await this.client.getCard(cardId) as TrelloCard & { idBoard?: string };
      const boardId = String((card as any)?.idBoard || '').trim();
      return boardId || undefined;
    } catch {
      return undefined;
    }
  }

  private async getBoardIdsForCard(cardId: string): Promise<BoardIds> {
    const boardId = await this.resolveCardBoardId(cardId) || this.getPrimaryBoardId();
    const cached = this.boardIdsByBoardId.get(boardId);
    if (cached) return cached;

    const resolved = await this.resolveBoardIdsFromExistingState(boardId);
    this.boardIdsByBoardId.set(boardId, resolved);
    return resolved;
  }

  private async handleRoutedEvent(event: RoutedEvent): Promise<void> {
    const { cardId, agentId, session } = event;
    if (!event.isFollowUp && this.activeRoutedCards.has(cardId)) {
      console.log(`[TrelloChannel] Skipping duplicate routed event while session is active cardId=${cardId}`);
      return;
    }
    this.activeRoutedCards.add(cardId);

    let text = event.text;
    if (!event.isFollowUp) {
      const fingerprint = `${agentId}:${String(text || '').trim().toLowerCase()}`;
      const now = Date.now();
      const previous = this.lastRoutedFingerprintByCardId.get(cardId);
      if (previous && (now - previous.at) < this.routedEventDedupWindowMs) {
        console.log(`[TrelloChannel] Skipping duplicate routed event in dedup window cardId=${cardId}`);
        this.activeRoutedCards.delete(cardId);
        return;
      }
      this.lastRoutedFingerprintByCardId.set(cardId, { fingerprint, at: now });
    }

    const creatorAssignMode = this.getCreatorAssignModeFromPrompt(text);
    const boardIds = await this.getBoardIdsForCard(cardId);
    const demoScriptMatchInput = event.isFollowUp
      ? (this.extractLatestUserCommentFromDispatchText(text) || '')
      : text;
    const demoScriptMatch = matchDemoScriptPrompt(demoScriptMatchInput);
    const shouldSkipProgressChecklist = demoScriptMatch?.id === 'product-launch-announcement';
    const progressChecklist = shouldSkipProgressChecklist
      ? undefined
      : await this.ensureLongRunningProgressChecklist(cardId, text);
    trelloPowerupStats.sessionStarted += 1;
    trelloPowerupStats.activeSessions += 1;

    if (await this.isReadOnlyLinkCard(cardId)) {
      this.store.delete(cardId);
      return;
    }

    if (!event.isFollowUp) {
      const boardId = await this.resolveCardBoardId(cardId) || this.getPrimaryBoardId();
      let fullCard: any;
      try {
        fullCard = await this.client.getCard(cardId);
      } catch (err) {
        console.error(`[TrelloChannel] Failed to fetch card ${cardId} for intake gating:`, err);
        this.store.delete(cardId);
        return;
      }

      if (this.isPromptInstructionCard(fullCard)) {
        this.store.delete(cardId);
        return;
      }

      const listId = String((fullCard as any)?.idList || '').trim();
      const promptInstructions = listId
        ? await this.getPromptInstructionsForList(boardId, listId, cardId)
        : undefined;
      const hasManualAssignment = await this.hasManualAutomationMemberAssignment(fullCard, boardId);
      if (!promptInstructions && !hasManualAssignment) {
        this.store.delete(cardId);
        return;
      }

      if (promptInstructions && !text.includes('List Instructions (from Prompt card, MANDATORY):')) {
        text = `${text}\n\nList Instructions (from Prompt card, MANDATORY):\n${promptInstructions}\n\nApply these instructions directly. Do not ask the user to repeat or paste them.`;
      }
    }

    if (boardIds.inProgressListId) {
      try {
        await this.client.moveCard(cardId, boardIds.inProgressListId);
      } catch (err) {
        console.error(`[TrelloChannel] Failed to move card ${cardId} to In Progress:`, err);
      }
    }
    if (this.botMemberId) {
      try {
        await this.client.addMember(cardId, this.botMemberId);
        await this.enforceSingleAutomationAgentMember(cardId, this.botMemberId);
      } catch (err) {
        console.error(`[TrelloChannel] Failed to assign bot to card ${cardId}:`, err);
      }
    }

    if (!this.store.get(cardId)) this.store.create(cardId, agentId);
    this.store.appendHistory(cardId, 'user', text);

    if (progressChecklist) {
      await this.completeProgressChecklistItem(cardId, progressChecklist.checklistName, progressChecklist.intakeItemName);
    }

    if (creatorAssignMode === 'immediate') {
      await this.addCardCreatorAsMember(cardId);
    }

    let responseSent = false;

    const interimTimer = setTimeout(async () => {
      if (!responseSent) {
        try {
          await this.client.addComment(cardId, 'Picked up. Drafting now.');
        } catch (err) {
          console.error('[TrelloChannel] Failed to post interim comment:', err);
        }
      }
    }, this.interimThresholdMs);

    try {
      const response = demoScriptMatch
        ? buildDemoScriptWorkflowResponse(demoScriptMatch)
        : await this.dispatchToAgent(agentId, text, session.cardId, cardId);

      if (demoScriptMatch) {
        console.log(`[TrelloChannel] demo script matched id=${demoScriptMatch.id} cardId=${cardId}`);
      }

      responseSent = true;
      clearTimeout(interimTimer);

      if (progressChecklist) {
        await this.completeProgressChecklistItem(cardId, progressChecklist.checklistName, progressChecklist.researchItemName);
      }

      this.store.appendHistory(cardId, 'agent', response);

      let commentText = response;
      let workflowMovedCard = false;
      let storedResearchInDescription = false;
      let deferredCreatorMemberAdd = false;
      try {
        const jsonStr = response.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        if (jsonStr.startsWith('{')) {
          const parsed = JSON.parse(jsonStr);

          if (parsed.type === 'workflow' && Array.isArray(parsed.operations)) {
            const validatedOperations = this.validateWorkflowOperations(parsed.operations);
            const workflowPrep = await this.prepareWorkflowOperationsForExecution(cardId, text, validatedOperations, creatorAssignMode);
            const workflowResults = await this.executeWorkflow(cardId, workflowPrep.operations);
            deferredCreatorMemberAdd = workflowPrep.deferCreatorMemberAdd;
            workflowMovedCard = workflowResults.some(result => result.ok && String(result.op || '').toLowerCase() === 'move_card');
            commentText = this.buildWorkflowUserComment(workflowResults);
            if (workflowPrep.storedResearchInDescription) {
              storedResearchInDescription = true;
              commentText = 'Done. Added research to the card description.';
            }

          } else if (parsed.type === 'image') {
            const { generateImage } = await import('./tools');
            const filename = this.sanitizeAttachmentBaseName(parsed.filename || 'generated-image');
            const artifactRunId = this.createArtifactRunId(cardId);
            let resolvedImage = await this.resolveImageFromAgentPayload(parsed, filename, { cardId, artifactRunId });
            if (!resolvedImage) {
              if (!parsed.prompt) {
                throw new Error('Image payload missing agent artifact and prompt fallback');
              }
              const { buffer, mimeType, filename: generatedFilename } = await generateImage(parsed.prompt);
              resolvedImage = {
                buffer,
                mimeType,
                filename: this.normalizeImageFilename(filename, mimeType, generatedFilename),
              };
            }
            const attachFilename = resolvedImage.filename;
            await this.saveGeneratedImageLocally(attachFilename, resolvedImage.buffer, { cardId, artifactRunId });
            const attachment = await this.client.uploadAttachment(cardId, attachFilename, resolvedImage.buffer, resolvedImage.mimeType);
            await this.client.setCardCoverToAttachment(cardId, attachment.id);
            const providedCopy = this.sanitizeAgentOutputText(String(parsed.copy || ''));
            const draftCopy = providedCopy || await this.generateDraftPostCopy(agentId, text, session.cardId, cardId);
            commentText = `Done.\n\n${draftCopy}`;

          } else if (parsed.filename && parsed.content) {
            const { generatePdf } = await import('./tools');
            const pdfBuffer = await generatePdf(parsed.filename, parsed.content);
            const pdfFilename = parsed.filename.endsWith('.pdf') ? parsed.filename : `${parsed.filename}.pdf`;
            await this.client.uploadAttachment(cardId, pdfFilename, pdfBuffer, 'application/pdf');
            commentText = 'Done.';
          }
        }
      } catch (attachErr) {
        console.error('[TrelloChannel] Attachment generation failed:', attachErr);
      }

      if (!workflowMovedCard) {
        const cardBoardId = await this.resolveCardBoardId(cardId);
        await this.moveCardToListMappedByLabel(cardId, cardBoardId);
      }

      if (progressChecklist) {
        await this.completeProgressChecklistItem(cardId, progressChecklist.checklistName, progressChecklist.synthesisItemName);
      }

      commentText = this.sanitizeAgentOutputText(commentText) || 'Done.';
      if (!storedResearchInDescription && this.shouldStoreResponseInDescription(text, commentText)) {
        const wroteResearch = await this.writeResearchResultToDescription(cardId, commentText);
        if (wroteResearch) {
          commentText = 'Done. Added research to the card description.';
        }
      }
      const safeComment = await this.enforceDemoPassMarkers(cardId, commentText);
      if (await this.hasRecentIdenticalAutomationComment(cardId, safeComment)) {
        console.log(`[TrelloChannel] Suppressed duplicate final comment cardId=${cardId}`);
      } else {
        await this.client.addComment(cardId, safeComment);
      }
      if (progressChecklist) {
        await this.completeProgressChecklistItem(cardId, progressChecklist.checklistName, progressChecklist.deliveryItemName);
      }
      if (creatorAssignMode === 'after_completion' || deferredCreatorMemberAdd) {
        // Trello action timestamps can lag comment persistence, so pause briefly
        // before deferred member add to preserve expected "when done" ordering.
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.addCardCreatorAsMember(cardId);
      }
      trelloPowerupStats.sessionCompleted += 1;
    } catch (err) {
      trelloPowerupStats.sessionFailed += 1;
      responseSent = true;
      clearTimeout(interimTimer);
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.client.addComment(cardId, `Sorry, something went wrong: ${message}`);
      } catch (postErr) {
        console.error('[TrelloChannel] Failed to post error comment:', postErr);
      }
    } finally {
      if (trelloPowerupStats.activeSessions > 0) {
        trelloPowerupStats.activeSessions -= 1;
      }
      this.store.delete(cardId);
      this.activeRoutedCards.delete(cardId);
    }
  }

  private extractLatestUserCommentFromDispatchText(text: string): string | undefined {
    const marker = 'New User Comment:';
    const raw = String(text || '');
    const idx = raw.lastIndexOf(marker);
    if (idx === -1) return undefined;

    const tail = raw.slice(idx + marker.length).trim();
    if (!tail || tail === '(empty comment)') return undefined;
    return tail;
  }

  private async hasRecentIdenticalAutomationComment(cardId: string, text: string): Promise<boolean> {
    const normalizedTarget = String(text || '').trim();
    if (!normalizedTarget) return false;

    try {
      const comments = await this.client.getCardComments(cardId, 10);
      const now = Date.now();
      for (const comment of comments) {
        const body = String(comment?.data?.text || '').trim();
        if (body !== normalizedTarget) continue;

        const isAutomationAuthor = String(comment?.memberCreator?.id || '').trim() === this.botMemberId;
        if (!isAutomationAuthor) continue;

        const ts = Date.parse(String(comment?.date || ''));
        if (!Number.isFinite(ts)) return true;
        if ((now - ts) <= this.finalCommentDedupWindowMs) return true;
      }
    } catch (_err) {
      return false;
    }
    return false;
  }

  private async executeWorkflow(baseCardId: string, operations: WorkflowOperation[]): Promise<WorkflowExecutionResult[]> {
    const results: WorkflowExecutionResult[] = [];

    for (const operation of operations) {
      const op = String(operation?.op || '').trim().toLowerCase();
      if (!op) {
        results.push({ op: 'unknown', ok: false, detail: 'Missing operation name (op).' });
        continue;
      }

      try {
        const cardId = op === 'create_card'
          ? baseCardId
          : await this.resolveOperationCardId(baseCardId, operation);
        const operationBoardId = await this.resolveCardBoardId(cardId) || this.getPrimaryBoardId();

        switch (op) {
          case 'attach_self':
          case 'assign_self': {
            if (!this.botMemberId) throw new Error('Bot member ID is unavailable.');
            try {
              await this.client.addMember(cardId, this.botMemberId);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (!message.toLowerCase().includes('already on the card')) throw err;
            }
            await this.enforceSingleAutomationAgentMember(cardId, this.botMemberId);
            results.push({ op, ok: true, detail: `Bot member assigned to card ${cardId}.` });
            break;
          }
          case 'create_card': {
            const title = String(operation.cardName || '').trim();
            if (!title) throw new Error('cardName is required for create_card.');

            const listId = await this.resolveListId(
              operationBoardId,
              operation.listId,
              operation.listName || this.config.lists?.backlog,
            );
            const desc = String(operation.cardDesc || (operation as any).desc || operation.commentText || (operation as any).text || '').trim();
            const created = await this.client.createCard({
              idList: listId,
              name: title,
              desc,
              labelIds: [],
            });
            results.push({ op, ok: true, detail: `Created card ${(created as any)?.id || 'unknown'} in list ${listId}.` });
            break;
          }
          case 'update_description': {
            const desc = String(operation.cardDesc || (operation as any).desc || operation.commentText || (operation as any).text || '').trim();
            if (!desc) throw new Error('cardDesc (or desc/commentText/text) is required for update_description.');
            await this.client.updateDescription(cardId, desc);
            results.push({ op, ok: true, detail: `Updated description for card ${cardId}.` });
            break;
          }
          case 'move_card': {
            const listId = await this.resolveListId(operationBoardId, operation.listId, operation.listName);
            await this.client.moveCard(cardId, listId);
            results.push({ op, ok: true, detail: `Moved card ${cardId} to list ${listId}.` });
            break;
          }
          case 'set_dates': {
            await this.client.updateCardDates(cardId, {
              start: operation.start,
              due: operation.due,
              dueComplete: operation.dueComplete,
            });
            results.push({ op, ok: true, detail: `Updated card dates for ${cardId}.` });
            break;
          }
          case 'add_member': {
            const memberId = String(operation.memberId || '').trim();
            if (!memberId) throw new Error('memberId is required for add_member.');
            await this.client.addMember(cardId, memberId);
            await this.enforceSingleAutomationAgentMember(cardId, memberId);
            results.push({ op, ok: true, detail: `Added member ${memberId}.` });
            break;
          }
          case 'add_creator_member': {
            const creatorId = await this.resolveCardCreatorMemberId(cardId);
            if (!creatorId) throw new Error('Card creator member ID could not be resolved.');
            try {
              await this.client.addMember(cardId, creatorId);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (!message.toLowerCase().includes('already on the card')) throw err;
            }
            await this.enforceSingleAutomationAgentMember(cardId, creatorId);
            results.push({ op, ok: true, detail: `Added card creator ${creatorId}.` });
            break;
          }
          case 'remove_member': {
            if (!operation.memberId) throw new Error('memberId is required for remove_member.');
            await this.client.removeMember(cardId, operation.memberId);
            results.push({ op, ok: true, detail: `Removed member ${operation.memberId}.` });
            break;
          }
          case 'set_members': {
            const memberIds = Array.isArray(operation.memberIds)
              ? operation.memberIds
              : operation.memberId
              ? [operation.memberId]
              : [];
            if (!memberIds.length) throw new Error('memberIds[] (or memberId) is required for set_members.');
            await this.client.setMembers(cardId, memberIds);
            const automationIds = await this.getConfiguredAutomationMemberIds(operationBoardId);
            const preferredAutomationMemberId = memberIds.find(memberId => automationIds.has(String(memberId || '').trim()));
            await this.enforceSingleAutomationAgentMember(cardId, preferredAutomationMemberId);
            results.push({ op, ok: true, detail: `Set ${memberIds.length} members.` });
            break;
          }
          case 'add_label': {
            const labelId = await this.resolveLabelId(
              operationBoardId,
              operation.labelId,
              operation.labelName,
              operation.labelColor,
              { createIfMissing: true },
            );
            await this.client.addLabel(cardId, labelId);
            results.push({ op, ok: true, detail: `Added label ${labelId}.` });
            break;
          }
          case 'remove_label': {
            try {
              const labelId = await this.resolveLabelId(
                operationBoardId,
                operation.labelId,
                operation.labelName,
                operation.labelColor,
              );
              await this.client.removeLabel(cardId, labelId);
              results.push({ op, ok: true, detail: `Removed label ${labelId}.` });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (message.includes('Label not found by name')) {
                results.push({ op, ok: true, detail: 'Label not present; nothing to remove.' });
              } else {
                throw err;
              }
            }
            break;
          }
          case 'add_checklist_item': {
            const checklistName = String(operation.checklistName || '').trim();
            if (!checklistName) throw new Error('checklistName is required for add_checklist_item.');

            const checklistItemName = String(operation.checklistItemName || '').trim();
            if (!checklistItemName) throw new Error('checklistItemName is required for add_checklist_item.');

            const checklists = await this.client.getCardChecklists(cardId);
            let matchingChecklists = checklists.filter(item => this.matchesConfiguredValue(item.name, checklistName));
            let checklist = matchingChecklists[0];

            const existingItem = matchingChecklists
              .flatMap(item => item.checkItems || [])
              .find(item => this.matchesConfiguredValue(item.name || '', checklistItemName));
            if (existingItem?.id) {
              results.push({ op, ok: true, detail: `Checklist item already exists: ${existingItem.id}.` });
              break;
            }

            if (!checklist) {
              await this.client.createChecklist(cardId, checklistName);
              matchingChecklists = (await this.client.getCardChecklists(cardId)).filter(item => this.matchesConfiguredValue(item.name, checklistName));
              checklist = matchingChecklists[0];
            }
            if (!checklist?.id) {
              throw new Error(`Checklist not found or could not be created: ${checklistName}`);
            }

            await this.client.addChecklistItem(checklist.id, checklistItemName);
            results.push({ op, ok: true, detail: `Checklist item added to ${checklist.id}.` });
            break;
          }
          case 'update_checklist_item': {
            const item = await this.resolveChecklistItem(cardId, operation);
            const nextName = (operation.checklistItemNewName || '').trim();
            if (!nextName) throw new Error('checklistItemNewName is required for update_checklist_item.');
            await this.client.updateChecklistItemName(cardId, item.id, nextName);
            results.push({ op, ok: true, detail: `Checklist item ${item.id} renamed.` });
            break;
          }
          case 'complete_checklist_item': {
            const item = await this.resolveChecklistItem(cardId, operation);
            await this.client.updateChecklistItemState(cardId, item.id, 'complete');
            results.push({ op, ok: true, detail: `Checklist item ${item.id} marked complete.` });
            break;
          }
          case 'add_comment': {
            const text = String(operation.commentText || (operation as any).text || '').trim();
            if (!text) throw new Error('commentText (or text) is required for add_comment.');
            await this.client.addComment(cardId, text);
            results.push({ op, ok: true, detail: 'Comment posted.' });
            break;
          }
          case 'update_comment': {
            const text = String(operation.commentText || (operation as any).text || '').trim();
            if (!text) throw new Error('commentText (or text) is required for update_comment.');
            const matchText = String(operation.commentMatchText || (operation as any).matchText || '').trim();
            const comments = await this.client.getCardComments(cardId, 100);
            const target = matchText
              ? comments.find(comment =>
                  (comment.data?.text || '').toLowerCase().includes(matchText.toLowerCase())
                )
              : comments[0];
            if (!target?.id) {
              await this.client.addComment(cardId, text);
              results.push({ op, ok: true, detail: 'No existing comment matched; posted a new comment instead.' });
            } else {
              await this.client.updateComment(cardId, target.id, text);
              results.push({ op, ok: true, detail: `Updated comment ${target.id}.` });
            }
            break;
          }
          case 'attach_link': {
            if (!operation.url) throw new Error('url is required for attach_link.');
            const localPath = await this.resolveLocalAttachmentPath(String(operation.url));
            if (localPath) {
              const data = await fs.readFile(localPath);
              const filename = String(operation.filename || '').trim() || path.basename(localPath) || 'attachment.bin';
              const existingAttachments = await this.client.getCardAttachments(cardId);
              const existingByName = existingAttachments.find(att => String(att?.name || '').trim() === filename);
              if (existingByName) {
                results.push({ op, ok: true, detail: `Skipped upload; attachment named ${filename} already exists.` });
                break;
              }
              const mimeType = this.guessMimeTypeFromFilename(filename);
              const attachment = await this.client.uploadAttachment(cardId, filename, data, mimeType);
              results.push({ op, ok: true, detail: `Uploaded file attachment ${attachment.url}.` });
            } else {
              const existingAttachments = await this.client.getCardAttachments(cardId);
              const existingLink = existingAttachments.find(att => String(att?.url || '').trim() === String(operation.url || '').trim());
              if (existingLink) {
                results.push({ op, ok: true, detail: `Skipped link attach; ${operation.url} already exists.` });
                break;
              }
              const attachment = await this.client.attachLink(cardId, operation.url, operation.filename);
              results.push({ op, ok: true, detail: `Attached link ${attachment.url}.` });
            }
            break;
          }
          case 'attach_remote_file': {
            const fileUrl = String(operation.url || '').trim();
            if (!fileUrl) throw new Error('url is required for attach_remote_file.');

            let parsedUrl: URL;
            try {
              parsedUrl = new URL(fileUrl);
            } catch {
              throw new Error(`Invalid URL for attach_remote_file: ${fileUrl}`);
            }
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
              throw new Error(`Unsupported URL protocol for attach_remote_file: ${parsedUrl.protocol}`);
            }

            const response = await fetch(fileUrl);
            if (!response.ok) {
              throw new Error(`Failed downloading remote file: HTTP ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const data = Buffer.from(arrayBuffer);
            if (!data.length) throw new Error('Downloaded remote file is empty.');

            const providedFilename = String(operation.filename || '').trim();
            const fallbackFilename = path.basename(parsedUrl.pathname || '') || 'attachment.bin';
            const filename = providedFilename || fallbackFilename;

            const existingAttachments = await this.client.getCardAttachments(cardId);
            const existingByName = existingAttachments.find(att => String(att?.name || '').trim() === filename);
            if (existingByName) {
              const setAsCover = Boolean((operation as any).setAsCover);
              if (setAsCover) {
                await this.client.setCardCoverToAttachment(cardId, existingByName.id);
                results.push({ op, ok: true, detail: `Skipped upload; attachment named ${filename} already exists and was set as cover.` });
              } else {
                results.push({ op, ok: true, detail: `Skipped upload; attachment named ${filename} already exists.` });
              }
              break;
            }

            const mimeTypeHeader = String(response.headers.get('content-type') || '').split(';')[0].trim();
            const mimeType = String((operation as any).mimeType || '').trim() || mimeTypeHeader || this.guessMimeTypeFromFilename(filename);

            const attachment = await this.client.uploadAttachment(cardId, filename, data, mimeType);
            const setAsCover = Boolean((operation as any).setAsCover);
            if (setAsCover) {
              await this.client.setCardCoverToAttachment(cardId, attachment.id);
              results.push({ op, ok: true, detail: `Uploaded remote file attachment ${attachment.url} and set as cover.` });
            } else {
              results.push({ op, ok: true, detail: `Uploaded remote file attachment ${attachment.url}.` });
            }
            break;
          }
          case 'mark_complete': {
            await this.client.markCardComplete(cardId);
            const targetDoneList = operation.listName || this.config.lists?.done;
            if (operation.listId || operation.listName) {
              const listId = await this.resolveListId(operationBoardId, operation.listId, targetDoneList);
              await this.client.moveCard(cardId, listId);
            } else if (targetDoneList) {
              // Best-effort: some boards intentionally do not include a Done list.
              try {
                const listId = await this.resolveListId(operationBoardId, undefined, targetDoneList);
                await this.client.moveCard(cardId, listId);
              } catch (err) {
                console.warn(`[TrelloChannel] mark_complete: optional done-list move skipped for ${cardId}:`, err);
              }
            }
            results.push({ op, ok: true, detail: `Card ${cardId} marked complete.` });
            break;
          }
          case 'archive_card': {
            await this.client.archiveCard(cardId);
            results.push({ op, ok: true, detail: `Card ${cardId} archived.` });
            break;
          }
          default:
            results.push({ op, ok: false, detail: `Unsupported operation: ${op}` });
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ op, ok: false, detail: message });
      }
    }

    return results;
  }

  private validateWorkflowOperations(operations: unknown[]): WorkflowOperation[] {
    if (!Array.isArray(operations)) {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operations must be an array`);
    }

    return operations.map((operation, index) => this.validateWorkflowOperation(operation, index));
  }

  private validateWorkflowOperation(operation: unknown, index: number): WorkflowOperation {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}] must be an object`);
    }

    const candidate = operation as Record<string, unknown>;
    for (const key of Object.keys(candidate)) {
      if (!WORKFLOW_ALLOWED_KEYS.has(key)) {
        throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}] has unknown key "${key}"`);
      }
    }

    const op = String(candidate.op || '').trim().toLowerCase();
    if (!op) {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}] is missing "op"`);
    }
    if (!WORKFLOW_ALLOWED_OPS.has(op)) {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}] has unsupported op "${op}"`);
    }

    if ('allowCrossCard' in candidate && typeof candidate.allowCrossCard !== 'boolean') {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].allowCrossCard must be a boolean`);
    }
    if ('setAsCover' in candidate && typeof (candidate as any).setAsCover !== 'boolean') {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].setAsCover must be a boolean`);
    }
    if ('memberIds' in candidate) {
      const memberIds = candidate.memberIds;
      if (!Array.isArray(memberIds) || memberIds.some((value) => typeof value !== 'string')) {
        throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].memberIds must be an array of strings`);
      }
    }
    if ('dueComplete' in candidate && typeof candidate.dueComplete !== 'boolean') {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].dueComplete must be a boolean`);
    }

    const optionalStringFields = [
      'cardName',
      'listName',
      'listId',
      'checklistName',
      'checklistItemName',
      'checklistItemNewName',
      'checklistItemId',
      'labelName',
      'labelColor',
      'labelId',
      'memberId',
      'commentText',
      'commentMatchText',
      'url',
      'filename',
      'text',
      'matchText',
    ];
    for (const field of optionalStringFields) {
      if (field in candidate && candidate[field] != null && typeof candidate[field] !== 'string') {
        throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].${field} must be a string`);
      }
    }

    if ('due' in candidate && candidate.due !== null && typeof candidate.due !== 'string') {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].due must be a string or null`);
    }
    if ('start' in candidate && candidate.start !== null && typeof candidate.start !== 'string') {
      throw new Error(`Workflow contract v${WORKFLOW_CONTRACT_VERSION}: operation[${index}].start must be a string or null`);
    }

    return { ...candidate, op } as WorkflowOperation;
  }

  private async resolveOperationCardId(baseCardId: string, operation: WorkflowOperation): Promise<string> {
    if (!operation.cardName) return baseCardId;

    const envAllowsCrossCard = /^(1|true|yes)$/i.test(String(process.env.TRELLO_ALLOW_CROSS_CARD_WORKFLOW || '').trim());
    const opAllowsCrossCard = operation.allowCrossCard === true;
    if (!envAllowsCrossCard && !opAllowsCrossCard) {
      throw new Error('Cross-card workflow operations are disabled by default; set allowCrossCard=true for this operation.');
    }

    const listId = operation.listId
      ? operation.listId
      : operation.listName
      ? await this.resolveListId(this.getPrimaryBoardId(), undefined, operation.listName)
      : undefined;

    const matched = await this.client.findCardByName(this.getPrimaryBoardId(), operation.cardName, { listId });
    if (!matched?.id) {
      throw new Error(`Card not found by name: ${operation.cardName}`);
    }
    return matched.id;
  }

  private async resolveListId(boardId: string, listId?: string, listName?: string): Promise<string> {
    if (listId) return listId;
    if (!listName) throw new Error('listId or listName is required for this operation.');
    const list = await this.client.findListByName(boardId, listName);
    if (!list?.id) throw new Error(`List not found by name: ${listName}`);
    return list.id;
  }

  private async resolveLabelId(
    boardId: string,
    labelId?: string,
    labelName?: string,
    labelColor?: string,
    options?: { createIfMissing?: boolean },
  ): Promise<string> {
    if (labelId) return labelId;
    if (!labelName && !labelColor) {
      throw new Error('labelId, labelName, or labelColor is required for this operation.');
    }

    const requestedName = (labelName || '').trim().toLowerCase();
    const requestedColor = (labelColor || '').trim().toLowerCase();
    const colorFromName = requestedName && this.isKnownLabelColor(requestedName) ? requestedName : '';
    const targetColor = requestedColor || colorFromName;

    const labels = await this.client.getLabels(boardId);

    const matched = labels.find(label => {
      const name = String(label.name || '').trim().toLowerCase();
      const color = String(label.color || '').trim().toLowerCase();
      if (requestedName && name && name === requestedName) return true;
      if (targetColor && color === targetColor) return true;
      return false;
    });

    if (matched?.id) return matched.id;

    if (options?.createIfMissing) {
      const createdName = targetColor ? '' : (labelName || '').trim();
      const createdColor = targetColor || 'blue';
      const created = await this.client.createLabel(boardId, createdName, createdColor);
      return created.id;
    }

    if (targetColor) {
      throw new Error(`Label not found by color: ${targetColor}`);
    }
    throw new Error(`Label not found by name: ${labelName}`);
  }

  private isKnownLabelColor(value: string): boolean {
    return new Set([
      'green',
      'yellow',
      'orange',
      'red',
      'purple',
      'blue',
      'sky',
      'lime',
      'pink',
      'black',
    ]).has(value);
  }

  private async resolveChecklistItem(cardId: string, operation: WorkflowOperation): Promise<{ id: string }> {
    const checklists = await this.client.getCardChecklists(cardId);
    if (!checklists.length) throw new Error('No checklists found on card.');

    const checklist = operation.checklistName
      ? checklists.find(item => this.matchesConfiguredValue(item.name, operation.checklistName!))
      : checklists[0];
    if (!checklist) throw new Error(`Checklist not found: ${operation.checklistName}`);

    if (operation.checklistItemId) {
      const byId = (checklist.checkItems || []).find(item => item.id === operation.checklistItemId);
      if (!byId) throw new Error(`Checklist item not found by id: ${operation.checklistItemId}`);
      return { id: byId.id };
    }

    if (!operation.checklistItemName) {
      throw new Error('checklistItemId or checklistItemName is required for checklist operations.');
    }
    const targetName = operation.checklistItemName;
    const byName = (checklist.checkItems || []).find(item => {
      if (this.matchesConfiguredValue(item.name, targetName)) return true;
      const itemNorm = String(item.name || '').trim().toLowerCase();
      const targetNorm = String(targetName || '').trim().toLowerCase();
      return itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm);
    });
    if (!byName) throw new Error(`Checklist item not found by name: ${operation.checklistItemName}`);
    return { id: byName.id };
  }

  private buildWorkflowUserComment(results: WorkflowExecutionResult[]): string {
    const ok = results.filter(result => result.ok);
    return ok.length === results.length ? 'Done.' : 'Done with partial completion.';
  }

  private describeWorkflowCapability(op: string): string {
    const normalized = String(op || '').toLowerCase();
    if (normalized === 'assign_self' || normalized === 'attach_self') return 'assigning the automation account';
    if (normalized === 'move_card') return 'moving cards across lists';
    if (normalized === 'set_dates') return 'updating due/start dates';
    if (normalized === 'add_member' || normalized === 'remove_member' || normalized === 'set_members') return 'managing card members';
    if (normalized === 'add_label' || normalized === 'remove_label') return 'managing labels';
    if (normalized === 'update_checklist_item' || normalized === 'complete_checklist_item') return 'updating checklist items';
    if (normalized === 'add_comment' || normalized === 'update_comment') return 'comment interactions';
    if (normalized === 'attach_link') return 'attaching links';
    if (normalized === 'attach_remote_file') return 'downloading and uploading remote files';
    if (normalized === 'mark_complete') return 'marking cards complete';
    if (normalized === 'archive_card') return 'archiving cards';
    return '';
  }

  private buildSummary(session: { history: Array<{ role: string; text: string }> }): string {
    const lines = session.history.map(h => `**${h.role === 'user' ? 'You' : 'Agent'}:** ${h.text}`);
    return `## Conversation Summary\n\n${lines.join('\n\n')}`;
  }

  private getLabelColorForAgent(agentId: string): string | undefined {
    return Object.entries(this.config.agentLabels).find(([, id]) => id === agentId)?.[0];
  }

  private matchesConfiguredValue(actual: string, expected: string): boolean {
    return actual.trim().toLowerCase() === expected.trim().toLowerCase();
  }

  private normalizeListOrLabelName(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private sanitizeAgentOutputText(value: string): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return '';
    const noFence = trimmed.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
    if (noFence.startsWith('{') && noFence.endsWith('}')) return '';
    return noFence;
  }

  private isLongRunningTask(text: string): boolean {
    const normalized = String(text || '').toLowerCase();
    if (!normalized) return false;

    const longTaskSignals = [
      /\bdeep research\b/,
      /\bcomprehensive\b/,
      /\bthorough\b/,
      /\binvestigate\b/,
      /\bresearch\b/,
      /\banaly[sz]e\b/,
      /\bbenchmark\b/,
      /\bcompare\b/,
      /\bmarket\s+research\b/,
      /\breport\b/,
      /\bmulti[- ]step\b/,
    ];

    return longTaskSignals.some(pattern => pattern.test(normalized)) || normalized.length > 350;
  }

  private async ensureLongRunningProgressChecklist(cardId: string, text: string): Promise<{
    checklistName: string;
    intakeItemName: string;
    researchItemName: string;
    synthesisItemName: string;
    deliveryItemName: string;
  } | undefined> {
    if (!this.isLongRunningTask(text)) return undefined;

    const checklistName = 'OpenClaw Progress';
    const intakeItemName = 'Intake and plan';
    const researchItemName = 'Research and investigation';
    const synthesisItemName = 'Synthesize findings';
    const deliveryItemName = 'Deliver final response';

    let checklist = (await this.client.getCardChecklists(cardId)).find(item => this.matchesConfiguredValue(item.name, checklistName));
    if (!checklist) {
      await this.client.createChecklist(cardId, checklistName);
      checklist = (await this.client.getCardChecklists(cardId)).find(item => this.matchesConfiguredValue(item.name, checklistName));
    }
    if (!checklist?.id) {
      return undefined;
    }

    const existingItems = new Set((checklist.checkItems || []).map(item => this.normalizeListOrLabelName(item.name || '')));
    const requiredItems = [intakeItemName, researchItemName, synthesisItemName, deliveryItemName];
    for (const itemName of requiredItems) {
      if (!existingItems.has(this.normalizeListOrLabelName(itemName))) {
        await this.client.addChecklistItem(checklist.id, itemName);
      }
    }

    return {
      checklistName,
      intakeItemName,
      researchItemName,
      synthesisItemName,
      deliveryItemName,
    };
  }

  private async completeProgressChecklistItem(cardId: string, checklistName: string, itemName: string): Promise<void> {
    try {
      const checklists = await this.client.getCardChecklists(cardId);
      const checklist = checklists.find(item => this.matchesConfiguredValue(item.name, checklistName));
      if (!checklist) return;

      const target = (checklist.checkItems || []).find(item => this.matchesConfiguredValue(item.name, itemName));
      if (!target?.id) return;
      if (target.state === 'complete') return;

      await this.client.updateChecklistItemState(cardId, target.id, 'complete');
    } catch (err) {
      console.warn(`[TrelloChannel] Failed to update progress checklist on ${cardId}:`, err);
    }
  }

  private async isReadOnlyLinkCard(cardId: string, existingCard?: any): Promise<boolean> {
    const card = existingCard || await this.client.getCard(cardId);
    const name = String((card as any)?.name || '').trim();
    const desc = String((card as any)?.desc || '').trim();

    // URL-only title cards are treated as immutable context link cards.
    if (this.looksLikeStandaloneUrl(name) && !desc) {
      return true;
    }

    if (desc) return false;

    let attachments: Array<{ id: string; url?: string; mimeType?: string; isUpload?: boolean }> = [];
    try {
      attachments = await this.client.getCardAttachments(cardId);
    } catch {
      return false;
    }

    if (!attachments.length) return false;
    const hasUploadedAttachment = attachments.some(att => att?.isUpload || !!att?.mimeType);
    if (hasUploadedAttachment) return false;

    const hasExternalLinkAttachment = attachments.some(att => {
      const url = String(att?.url || '').trim().toLowerCase();
      return url.startsWith('http://') || url.startsWith('https://');
    });
    return hasExternalLinkAttachment;
  }

  private async addCardCreatorAsMember(cardId: string): Promise<void> {
    try {
      const creatorId = await this.resolveCardCreatorMemberId(cardId);
      if (!creatorId) return;
      await this.client.addMember(cardId, creatorId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('already on the card')) return;
      console.error(`[TrelloChannel] Failed adding card creator as member for ${cardId}:`, err);
    }
  }

  private getCreatorAssignModeFromPrompt(text: string): 'none' | 'immediate' | 'after_completion' {
    const normalized = String(text || '').toLowerCase();
    if (!normalized) return 'none';

    const asksToAssignCreator = /\b(add|assign|include|attach)\s+me\b/.test(normalized)
      || /\badd\s+(the\s+)?(creator|author|owner)\b/.test(normalized)
      || /\bassign\s+(the\s+)?(creator|author|owner)\b/.test(normalized);
    if (!asksToAssignCreator) return 'none';

    const wantsAfterCompletion = /\b(when done|once done|after done|upon completion|on completion|after completion|when complete|once complete)\b/.test(normalized);
    return wantsAfterCompletion ? 'after_completion' : 'immediate';
  }

  private async resolveCardCreatorMemberId(cardId: string): Promise<string | undefined> {
    try {
      const query = new URLSearchParams({
        key: this.config.auth.apiKey,
        token: this.config.auth.token,
        // Cards may be created by copy flow, which emits copyCard instead of createCard.
        filter: 'createCard,copyCard,convertToCardFromCheckItem,moveCardToBoard',
        limit: '20',
      });
      const response = await fetch(`https://api.trello.com/1/cards/${cardId}/actions?${query.toString()}`);
      if (!response.ok) {
        throw new Error(`Trello API error ${response.status}: ${await response.text()}`);
      }
      const actions = await response.json() as Array<{ type?: string; date?: string; memberCreator?: { id?: string } }>;
      const candidate = (actions || [])
        .filter(action => {
          const t = String(action?.type || '').trim().toLowerCase();
          return t === 'createcard' || t === 'copycard' || t === 'converttocardfromcheckitem' || t === 'movecardtoboard';
        })
        .sort((a, b) => Date.parse(String(b?.date || 0)) - Date.parse(String(a?.date || 0)))[0];

      const creatorId = String(candidate?.memberCreator?.id || '').trim();
      if (creatorId) return creatorId;

      // Last-resort fallback: infer intent owner from latest human comment on card.
      const comments = await this.client.getCardComments(cardId, 20);
      const latestHumanComment = comments.find(comment => {
        const memberId = String(comment?.memberCreator?.id || '').trim();
        if (!memberId) return false;
        if (this.botMemberId && memberId === this.botMemberId) return false;
        return true;
      });
      const fallbackMemberId = String(latestHumanComment?.memberCreator?.id || '').trim();
      return fallbackMemberId || undefined;
    } catch (err) {
      console.error(`[TrelloChannel] Failed to resolve card creator for ${cardId}:`, err);
      return undefined;
    }
  }

  private looksLikeStandaloneUrl(value: string): boolean {
    const s = String(value || '').trim();
    if (!s) return false;
    return /^https?:\/\/[\w.-]+(?:\/[\S]*)?$/i.test(s);
  }

  private async prepareWorkflowOperationsForExecution(
    cardId: string,
    sourceText: string,
    operations: WorkflowOperation[],
    creatorAssignMode: 'none' | 'immediate' | 'after_completion' = 'none'
  ): Promise<{ operations: WorkflowOperation[]; storedResearchInDescription: boolean; deferCreatorMemberAdd: boolean }> {
    const filteredOperations: WorkflowOperation[] = [];
    let researchTextForDescription = '';
    let deferCreatorMemberAdd = false;

    const sourceLooksResearch = /\b(research|analyze|analysis|benchmark|compare|market|competitor|investigate|go\/no-go|wholesale)\b/i.test(String(sourceText || ''));

    for (const operation of operations) {
      const op = String((operation as any)?.op || '').trim().toLowerCase();

      if (op === 'add_member') {
        const explicitMemberId = String((operation as any)?.memberId || '').trim();
        if (!explicitMemberId) {
          const creatorId = await this.resolveCardCreatorMemberId(cardId);
          if (creatorAssignMode === 'after_completion') {
            deferCreatorMemberAdd = !!creatorId;
            continue;
          }
          if (creatorAssignMode === 'immediate' && creatorId) {
            filteredOperations.push({
              ...operation,
              memberId: creatorId,
            });
            continue;
          }
        }
      }

      if (op !== 'add_comment' && op !== 'update_comment') {
        filteredOperations.push(operation);
        continue;
      }

      const rawText = String((operation as any)?.commentText || (operation as any)?.text || '').trim();
      const cleaned = this.sanitizeAgentOutputText(rawText);
      if (!cleaned) continue;

      if (this.shouldStoreResponseInDescription(sourceText, cleaned)) {
        if (cleaned.length > researchTextForDescription.length) {
          researchTextForDescription = cleaned;
        }
        continue;
      }

      if (sourceLooksResearch) {
        // For research-class requests, suppress workflow comment bodies and let the final channel comment stay concise.
        continue;
      }

      filteredOperations.push({
        ...operation,
        commentText: cleaned,
      });
    }

    let storedResearchInDescription = false;
    if (researchTextForDescription) {
      storedResearchInDescription = await this.writeResearchResultToDescription(cardId, researchTextForDescription);
    }

    return { operations: filteredOperations, storedResearchInDescription, deferCreatorMemberAdd };
  }

  private shouldStoreResponseInDescription(sourceText: string, responseText: string): boolean {
    const source = String(sourceText || '').toLowerCase();
    const response = String(responseText || '').trim();
    if (!response || response.startsWith('{')) return false;

    const looksResearch = /\b(research|analyze|analysis|benchmark|compare|market|competitor|investigate|go\/no-go|wholesale)\b/i.test(source);
    return looksResearch && this.isSubstantiveResearchResponse(response);
  }

  private isSubstantiveResearchResponse(value: string): boolean {
    const response = String(value || '').trim();
    if (!response) return false;
    const normalized = response.toLowerCase();
    if (normalized === 'done.' || normalized === 'done') return false;
    if (normalized.includes('added research to the card description')) return false;
    if (normalized.includes('picked up. drafting now.')) return false;
    if (response.length < 180) return false;

    const hasStructure = /\n\s*[-*]\s+/.test(response) || /\n\d+\.\s+/.test(response);
    const hasEvidence = /https?:\/\//i.test(response) || /\b(source|sources)\b\s*:/i.test(response);
    return hasStructure || hasEvidence || response.length >= 260;
  }

  private async writeResearchResultToDescription(cardId: string, resultText: string): Promise<boolean> {
    const cleanedResult = this.sanitizeAgentOutputText(resultText);
    if (!this.isSubstantiveResearchResponse(cleanedResult)) return false;

    const card = await this.client.getCard(cardId);
    const existing = String((card as any)?.desc || '').trim();
    const section = `## Research Output\n\n${cleanedResult.trim()}`;

    let nextDesc = section;
    if (existing) {
      // Replace prior generated section if present to avoid unbounded growth.
      const marker = '\n\n## Research Output\n\n';
      const markerIndex = existing.indexOf(marker);
      if (markerIndex >= 0) {
        nextDesc = `${existing.slice(0, markerIndex).trim()}\n\n${section}`.trim();
      } else if (existing.startsWith('## Research Output\n\n')) {
        nextDesc = section;
      } else {
        nextDesc = `${existing}\n\n${section}`;
      }
    }

    const maxDescLength = 16000;
    if (nextDesc.length > maxDescLength) {
      const overflow = nextDesc.length - maxDescLength;
      const trimmedSection = section.slice(0, Math.max(0, section.length - overflow - 32)).trimEnd() + '\n\n[truncated]';
      if (existing && !existing.startsWith('## Research Output\n\n')) {
        nextDesc = `${existing}\n\n## Research Output\n\n${trimmedSection.replace(/^## Research Output\n\n/, '')}`;
      } else {
        nextDesc = `## Research Output\n\n${trimmedSection.replace(/^## Research Output\n\n/, '')}`;
      }
      if (nextDesc.length > maxDescLength) {
        nextDesc = nextDesc.slice(0, maxDescLength);
      }
    }

    await this.client.updateDescription(cardId, nextDesc);
    return true;
  }

  private async generateDraftPostCopy(agentId: string, sourceText: string, sessionCardId: string, trelloCardId: string): Promise<string> {
    const copyPrompt =
      `Write the final social post copy only. No JSON. No markdown. No explanation.\n\n` +
      `Use this request as input:\n${sourceText}`;
    try {
      const response = await this.dispatchToAgent(agentId, copyPrompt, sessionCardId, trelloCardId);
      const cleaned = this.sanitizeAgentOutputText(response);
      return cleaned || 'Draft post copy is ready.';
    } catch (err) {
      console.error('[TrelloChannel] Failed to generate standalone draft copy:', err);
      return 'Draft post copy is ready.';
    }
  }

  private async moveCardToListMappedByLabel(cardId: string, boardIdHint?: string): Promise<void> {
    try {
      const boardId = boardIdHint || await this.resolveCardBoardId(cardId) || this.getPrimaryBoardId();
      const card = await this.client.getCard(cardId);
      const boardLabels = await this.client.getLabels(boardId);
      const labels = Array.isArray((card as any)?.labels) ? (card as any).labels : [];
      const directLabelNames = labels
        .map((label: any) => String(label?.name || '').trim())
        .filter((name: string) => Boolean(name));
      const idLabelNames = Array.isArray((card as any)?.idLabels)
        ? (card as any).idLabels
            .map((id: any) => boardLabels.find((label) => String(label.id) === String(id))?.name || '')
            .map((name: any) => String(name || '').trim())
            .filter((name: string) => Boolean(name))
        : [];
      const labelNames = Array.from(new Set([...directLabelNames, ...idLabelNames]))
        .filter((name: string) => !this.matchesConfiguredValue(name, 'prompt'));
      if (!labelNames.length) return;

      const lists = await this.client.getLists(boardId);
      const normalizedLists = lists.map((list) => ({
        id: list.id,
        name: list.name,
        normalized: this.normalizeListOrLabelName(list.name),
      }));

      for (const labelName of labelNames) {
        const normalizedLabel = this.normalizeListOrLabelName(labelName);
        if (!normalizedLabel) continue;

        const exact = normalizedLists.find((list) => list.normalized === normalizedLabel);
        const fuzzy = normalizedLists.find((list) => {
          if (!list.normalized) return false;
          if (list.normalized.includes(normalizedLabel)) return true;
          if (normalizedLabel.includes(list.normalized)) return true;
          const labelParts = normalizedLabel.split(' ').filter(Boolean);
          return labelParts.length === 1 && labelParts[0].length >= 1 && list.normalized.split(' ').includes(labelParts[0]);
        });

        const target = exact || fuzzy;
        if (!target) continue;
        if ((card as any).idList === target.id) return;

        await this.client.moveCard(cardId, target.id);
        return;
      }
    } catch (err) {
      console.error('[TrelloChannel] Failed to move card by label mapping:', err);
    }
  }

  private selectTargetChecklist(
    checklists: TrelloChecklist[],
    configuredName?: string,
    eventChecklistId?: string,
  ): TrelloChecklist | undefined {
    if (configuredName) {
      return checklists.find(c => this.matchesConfiguredValue(c.name, configuredName));
    }
    if (eventChecklistId) {
      return checklists.find(c => c.id === eventChecklistId);
    }
    return checklists[0];
  }

  private async isThresholdAlreadyRecorded(cardId: string): Promise<boolean> {
    const comments = await this.client.getCardComments(cardId, 100);
    return comments.some(comment => (comment.data?.text ?? '').includes(THRESHOLD_MARKER));
  }

  private sanitizeAttachmentBaseName(value: string): string {
    const base = value.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
    return base.replace(/^-+|-+$/g, '') || 'generated-image';
  }

  private normalizeMemberIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids = value
      .map(memberId => String(memberId || '').trim())
      .filter(Boolean);
    return Array.from(new Set(ids));
  }

  private async readBoardPowerupConfig(boardId: string, opts: { forceRefresh?: boolean } = {}): Promise<any> {
    const now = Date.now();
    const cached = this.boardPowerupConfigCache.get(boardId);
    if (!opts.forceRefresh && cached && cached.expiresAt > now) {
      return cached.config;
    }

    let config: any = {};
    try {
      const rows = await this.client.getBoardPluginData(boardId);
      for (const row of rows || []) {
        const rawValue = String((row as any)?.value || '').trim();
        if (!rawValue) continue;
        try {
          const parsed = JSON.parse(rawValue);
          if (parsed && typeof parsed === 'object' && parsed.openclawStatsConfig && typeof parsed.openclawStatsConfig === 'object') {
            config = parsed.openclawStatsConfig;
            break;
          }
        } catch {
          // ignore malformed pluginData rows from other power-ups
        }
      }
    } catch {
      // keep empty config and continue with runtime defaults
    }

    this.boardPowerupConfigCache.set(boardId, {
      expiresAt: now + 60_000,
      config,
    });
    return config;
  }

  private async getConfiguredAutomationMemberIds(boardId: string): Promise<Set<string>> {
    const config = await this.readBoardPowerupConfig(boardId);
    const configuredIds = this.normalizeMemberIdList(config?.agentMemberIds);
    const resolved = new Set<string>(configuredIds);
    if (this.botMemberId) {
      resolved.add(this.botMemberId);
    }
    return resolved;
  }

  private async enforceSingleAutomationAgentMember(cardId: string, preferredMemberId?: string): Promise<void> {
    const boardId = await this.resolveCardBoardId(cardId) || this.getPrimaryBoardId();
    const automationIds = await this.getConfiguredAutomationMemberIds(boardId);
    if (automationIds.size <= 1) return;

    const card = await this.client.getCard(cardId) as TrelloCard & { idMembers?: string[] };
    const cardMemberIds = Array.isArray((card as any)?.idMembers) ? ((card as any).idMembers as string[]) : [];
    const automationOnCard = cardMemberIds.filter(memberId => automationIds.has(String(memberId || '')));
    if (automationOnCard.length <= 1) return;

    const preferred = String(preferredMemberId || '').trim();
    const keepMemberId = (preferred && automationOnCard.includes(preferred))
      ? preferred
      : automationOnCard[0];

    for (const memberId of automationOnCard) {
      if (memberId === keepMemberId) continue;
      try {
        await this.client.removeMember(cardId, memberId);
      } catch (err) {
        console.warn(`[TrelloChannel] Failed enforcing one-agent-per-card for ${cardId}; remove ${memberId}:`, err);
      }
    }
  }

  async listPowerupBoardMembers(input: any): Promise<{
    boardId: string;
    members: Array<{
      id: string;
      fullName: string;
      username: string;
      avatarUrl: string;
      suggestedAgent: boolean;
      configuredAgent: boolean;
    }>;
  }> {
    this.ensureReadyForPowerupSetup();
    const boardId = this.ensureExpectedBoardId(input?.boardId);
    const members = await this.client.getBoardMembers(boardId);
    const config = await this.readBoardPowerupConfig(boardId, { forceRefresh: true });
    const configured = new Set(this.normalizeMemberIdList(config?.agentMemberIds));

    const normalizedMembers = (members || [])
      .map(member => {
        const id = String((member as any)?.id || '').trim();
        const username = String((member as any)?.username || '').trim();
        return {
          id,
          fullName: String((member as any)?.fullName || '').trim(),
          username,
          avatarUrl: String((member as any)?.avatarUrl || '').trim(),
          suggestedAgent: /_bot$/i.test(username),
          configuredAgent: configured.has(id),
        };
      })
      .filter(member => !!member.id)
      .sort((a, b) => {
        if (a.configuredAgent !== b.configuredAgent) return a.configuredAgent ? -1 : 1;
        return (a.fullName || a.username || a.id).localeCompare(b.fullName || b.username || b.id);
      });

    return {
      boardId,
      members: normalizedMembers,
    };
  }

  private ensureReadyForPowerupSetup(): void {
    if (!this.client || this.boardIdsByBoardId.size === 0) {
      throw new Error('Trello channel is not ready yet. Try again in a few seconds.');
    }
  }

  private normalizeBoardIdInput(value: unknown): string {
    return String(value || '').trim();
  }

  private ensureExpectedBoardId(value: unknown): string {
    const provided = this.normalizeBoardIdInput(value);
    const expected = this.getPrimaryBoardId();
    const configured = String(this.config.boardId || '').trim();
    if (!provided) return expected;
    if (configured && configured !== '*' && provided !== configured) {
      throw new Error(`Unsupported boardId ${provided}; expected ${configured}.`);
    }
    if (!this.watchedBoardIds.has(provided)) {
      throw new Error(`Unsupported boardId ${provided}; board is not in watched set.`);
    }
    return provided;
  }

  private buildPowerupSetupCardDescription(boardId: string): string {
    return [
      '# OpenClaw Stats Setup',
      '',
      'Edit the values below, then run Import in Power-Up settings.',
      '',
      `BOARD_ID=${boardId}`,
      'OPENCLAW_STATS_URL=https://<your-openclaw-host>/trello/powerup/stats',
      'OPENCLAW_STATS_TOKEN=',
      'OPENCLAW_INSTANCE_NAME=',
      'OPENCLAW_AGENT_MEMBER_IDS=',
      '',
      'Notes:',
      '- Use HTTPS URL.',
      '- Keep token blank if endpoint auth is disabled.',
      '- OPENCLAW_AGENT_MEMBER_IDS is a comma-separated list of Trello member IDs treated as automation agents.',
      '- This card will be archived after successful import.',
    ].join('\n');
  }

  private parsePowerupSetupConfig(description: string): {
    boardId?: string;
    statsUrl?: string;
    statsToken?: string;
    instanceName?: string;
    agentMemberIds?: string[];
  } {
    const lines = String(description || '').split(/\r?\n/);
    const parsed: { boardId?: string; statsUrl?: string; statsToken?: string; instanceName?: string; agentMemberIds?: string[] } = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim().toUpperCase();
      const value = trimmed.slice(idx + 1).trim();

      if (key === 'BOARD_ID') parsed.boardId = value;
      if (key === 'OPENCLAW_STATS_URL') parsed.statsUrl = value;
      if (key === 'OPENCLAW_STATS_TOKEN') parsed.statsToken = value;
      if (key === 'OPENCLAW_INSTANCE_NAME') parsed.instanceName = value;
      if (key === 'OPENCLAW_AGENT_MEMBER_IDS') {
        parsed.agentMemberIds = value
          .split(',')
          .map(memberId => memberId.trim())
          .filter(Boolean);
      }
    }

    return parsed;
  }

  private async probePowerupStatsEndpoint(statsUrl: string, statsToken?: string): Promise<{ ok: boolean; status: number }> {
    const url = new URL(statsUrl);
    if (statsToken) {
      url.searchParams.set('token', statsToken);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Stats endpoint probe failed with HTTP ${response.status}`);
      }
      const payload = await response.json() as any;
      if (!payload || typeof payload !== 'object' || !payload.sessions || !payload.usage) {
        throw new Error('Stats endpoint probe returned unexpected payload shape.');
      }
      return { ok: true, status: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  async createPowerupSetupCard(input: any): Promise<{ cardId: string; boardId: string; cardName: string; cardUrl: string }> {
    this.ensureReadyForPowerupSetup();
    const boardId = this.ensureExpectedBoardId(input?.boardId);
    const boardIds = this.boardIdsByBoardId.get(boardId) || await this.resolveBoardIdsFromExistingState(boardId);
    this.boardIdsByBoardId.set(boardId, boardIds);
    const lists = await this.client.getLists(boardId);
    const targetListId = boardIds.backlogListId || boardIds.inProgressListId || boardIds.doneListId || lists[0]?.id;
    if (!targetListId) {
      throw new Error('Unable to select a target list for setup card creation.');
    }

    const createdAt = new Date().toISOString().replace(/[:.]/g, '-');
    const cardName = `OpenClaw Stats Setup ${createdAt}`;
    const card = await this.client.createCard({
      idList: targetListId,
      name: cardName,
      desc: this.buildPowerupSetupCardDescription(boardId),
      labelIds: [],
    });

    return {
      cardId: String((card as any)?.id || ''),
      boardId,
      cardName,
      cardUrl: String((card as any)?.url || (card as any)?.shortUrl || ''),
    };
  }

  async importPowerupSetupCard(input: any): Promise<{
    boardId: string;
    cardId: string;
    archived: boolean;
    config: { statsUrl: string; statsToken: string; instanceName: string; agentMemberIds: string[] };
    probe: { ok: boolean; status: number };
  }> {
    this.ensureReadyForPowerupSetup();
    const boardId = this.ensureExpectedBoardId(input?.boardId);
    const cardId = String(input?.cardId || '').trim();
    if (!cardId) throw new Error('cardId is required.');

    const card = await this.client.getCard(cardId);
    const parsed = this.parsePowerupSetupConfig(String((card as any)?.desc || ''));
    const parsedBoardId = this.ensureExpectedBoardId(parsed.boardId || boardId);
    const statsUrl = String(parsed.statsUrl || '').trim();
    if (!statsUrl) {
      throw new Error('Setup card is missing OPENCLAW_STATS_URL.');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(statsUrl);
    } catch {
      throw new Error('OPENCLAW_STATS_URL is not a valid URL.');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('OPENCLAW_STATS_URL must use https.');
    }

    const statsToken = String(parsed.statsToken || '').trim();
    const instanceName = String(parsed.instanceName || '').trim();
    const agentMemberIds = this.normalizeMemberIdList(parsed.agentMemberIds || []);
    const probe = await this.probePowerupStatsEndpoint(parsedUrl.toString(), statsToken || undefined);
    await this.client.archiveCard(cardId);

    return {
      boardId: parsedBoardId,
      cardId,
      archived: true,
      config: {
        statsUrl: parsedUrl.toString(),
        statsToken,
        instanceName,
        agentMemberIds,
      },
      probe,
    };
  }

  private inferListIntent(listName: string): string {
    const text = String(listName || '').trim().toLowerCase();
    if (!text) return 'general';
    if (/(backlog|start|todo|to do|inbox|queue|ideas?)/i.test(text)) return 'intake';
    if (/(progress|doing|active|build|develop|draft|wip)/i.test(text)) return 'execution';
    if (/(review|qa|verify|test|approve|approval)/i.test(text)) return 'review';
    if (/(done|complete|shipped|released|archive|closed)/i.test(text)) return 'completion';
    return 'general';
  }

  private buildPromptCardDescription(boardName: string, listName: string, intent: string): string {
    const base = [
      '# Prompt Card',
      '',
      `This card defines list-level behavior for **${listName}** on board **${boardName}**.`,
      'When processing cards in this list, treat these instructions as mandatory context.',
      '',
      'Core rules:',
      '- Be concise and action-oriented.',
      '- Keep card state synchronized with actual progress.',
      '- If blocked, explain what is missing and the next unblock step.',
      '- Never ask the user to restate these list instructions.',
      '',
    ];

    if (intent === 'intake') {
      base.push(
        'List intent (intake):',
        '- Clarify scope, constraints, and expected outcome before execution.',
        '- Propose a short implementation plan and call out unknowns early.',
      );
    } else if (intent === 'execution') {
      base.push(
        'List intent (execution):',
        '- Prioritize concrete implementation and verification over discussion.',
        '- Update progress in short milestones while work is in flight.',
      );
    } else if (intent === 'review') {
      base.push(
        'List intent (review):',
        '- Focus on regressions, risks, and missing tests first.',
        '- Provide evidence with file paths, observed behavior, and severity.',
      );
    } else if (intent === 'completion') {
      base.push(
        'List intent (completion):',
        '- Summarize shipped outcome and verification evidence.',
        '- Record follow-ups and operational handoff notes when needed.',
      );
    } else {
      base.push(
        'List intent (general):',
        '- Infer the likely purpose of this list from card text and recent activity.',
        '- Keep outputs aligned with the board owner\'s workflow language.',
      );
    }

    return base.join('\n');
  }

  async bootstrapPowerupPromptCards(input: any): Promise<{
    boardId: string;
    created: number;
    skipped: number;
    cards: Array<{ listId: string; listName: string; cardId: string; cardName: string }>;
  }> {
    this.ensureReadyForPowerupSetup();
    const boardId = this.ensureExpectedBoardId(input?.boardId);
    const board = await this.client.getBoard(boardId);
    const lists = (await this.client.getLists(boardId)).filter(list => !(list as any)?.closed);
    if (!lists.length) {
      throw new Error('No open lists found on board for prompt bootstrap.');
    }

    const existingCards = await this.client.getBoardCards(boardId);
    const promptLabelId = await this.resolveLabelId(boardId, undefined, 'Prompt', undefined, { createIfMissing: true });

    let created = 0;
    let skipped = 0;
    const cards: Array<{ listId: string; listName: string; cardId: string; cardName: string }> = [];

    for (const list of lists) {
      const listId = String((list as any)?.id || '').trim();
      const listName = String((list as any)?.name || '').trim();
      if (!listId) continue;

      const hasPromptCard = existingCards.some(card => card.idList === listId && /(^|\b)prompt(\b|:)/i.test(String(card.name || '')));
      if (hasPromptCard) {
        skipped += 1;
        continue;
      }

      const intent = this.inferListIntent(listName);
      const cardName = `Prompt: ${listName || 'List'} Working Agreement`;
      const card = await this.client.createCard({
        idList: listId,
        name: cardName,
        desc: this.buildPromptCardDescription(board.name, listName || 'Unnamed List', intent),
        labelIds: promptLabelId ? [promptLabelId] : [],
      });

      created += 1;
      cards.push({
        listId,
        listName,
        cardId: String((card as any)?.id || ''),
        cardName,
      });
    }

    return {
      boardId,
      created,
      skipped,
      cards,
    };
  }

  private buildArtifactScopeSegment(value: string, fallback: string): string {
    const sanitized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return sanitized || fallback;
  }

  private createArtifactRunId(cardId: string): string {
    const cardScope = this.buildArtifactScopeSegment(cardId, 'card');
    const entropy = Math.random().toString(36).slice(2, 8);
    return `${cardScope}-${Date.now().toString(36)}-${entropy}`;
  }

  private extensionFromMimeType(mimeType: string): string {
    const type = String(mimeType || '').toLowerCase();
    if (type.includes('png')) return 'png';
    if (type.includes('webp')) return 'webp';
    if (type.includes('gif')) return 'gif';
    return 'jpg';
  }

  private normalizeImageFilename(baseName: string, mimeType: string, candidateFilename?: string): string {
    const candidate = String(candidateFilename || '').trim();
    if (candidate && /\.[a-z0-9]+$/i.test(candidate)) {
      return `${this.sanitizeAttachmentBaseName(candidate.replace(/\.[^.]+$/, ''))}.${candidate.split('.').pop()}`;
    }
    return `${baseName}.${this.extensionFromMimeType(mimeType)}`;
  }

  private parseImageDataUrl(value: string): { buffer: Buffer; mimeType: string } | null {
    const match = String(value).match(/^data:(.+?);base64,(.+)$/i);
    if (!match) return null;
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  private extractLocalAttachmentPath(value: string): string | undefined {
    const raw = String(value || '').trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').replace(/[),.;]+$/g, '');
    if (!raw) return undefined;

    if (raw.startsWith('/')) return raw;

    if (raw.toLowerCase().startsWith('file://')) {
      const withoutScheme = raw.replace(/^file:\/\//i, '');
      return withoutScheme.startsWith('/') ? withoutScheme : `/${withoutScheme}`;
    }

    if (/^https?:\/\/home\//i.test(raw)) {
      return raw.replace(/^https?:\/\/home\//i, '/home/');
    }

    if (/^https?:\/\/localhost\//i.test(raw) || /^https?:\/\/127\.0\.0\.1\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        return parsed.pathname || undefined;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private async resolveLocalAttachmentPath(value: string): Promise<string | undefined> {
    const direct = this.extractLocalAttachmentPath(value);
    if (direct && await this.pathExists(direct)) return direct;

    const parsed = this.extractLocalAttachmentPath(value);
    const basename = parsed ? path.basename(parsed) : path.basename(String(value || '').trim());
    if (!basename || basename === '.' || basename === '/') return undefined;

    const candidates = [
      path.join(OPENCLAW_WORKSPACE_DIR, basename),
      path.join(OPENCLAW_MEDIA_DIR, basename),
      path.join('/tmp', basename),
    ];

    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) return candidate;
    }
    return undefined;
  }

  private guessMimeTypeFromFilename(filename: string): string {
    const ext = String(path.extname(filename) || '').toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.pdf') return 'application/pdf';
    return 'application/octet-stream';
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async recoverGeneratedImagePath(
    brokenPath: string,
    context: { cardId: string; artifactRunId: string },
  ): Promise<string> {
    if (await this.pathExists(brokenPath)) return brokenPath;

    const cardScope = this.buildArtifactScopeSegment(context.cardId, 'card');
    const runScope = this.buildArtifactScopeSegment(context.artifactRunId, 'run');
    const scopedPath = path.join(GENERATED_IMAGE_DIR, cardScope, runScope, path.basename(String(brokenPath || '')));
    if (await this.pathExists(scopedPath)) return scopedPath;

    throw new Error(
      `imagePath not found at ${brokenPath}; refusing unscoped nearest-file recovery (card=${cardScope}, run=${runScope})`,
    );
  }

  private async resolveImageFromAgentPayload(
    parsed: any,
    baseFilename: string,
    context: { cardId: string; artifactRunId: string },
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.imageBase64) {
      const dataUrl = this.parseImageDataUrl(parsed.imageBase64);
      if (dataUrl) {
        return {
          buffer: dataUrl.buffer,
          mimeType: dataUrl.mimeType,
          filename: this.normalizeImageFilename(baseFilename, dataUrl.mimeType),
        };
      }
      const mimeType = String(parsed.mimeType || 'image/png');
      return {
        buffer: Buffer.from(String(parsed.imageBase64), 'base64'),
        mimeType,
        filename: this.normalizeImageFilename(baseFilename, mimeType),
      };
    }

    if (parsed.imageUrl) {
      const response = await fetch(String(parsed.imageUrl));
      if (!response.ok) {
        throw new Error(`Failed to fetch imageUrl (${response.status})`);
      }
      const mimeType = response.headers.get('content-type') || String(parsed.mimeType || 'image/jpeg');
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType,
        filename: this.normalizeImageFilename(baseFilename, mimeType),
      };
    }

    if (parsed.imagePath) {
      const imagePath = await this.recoverGeneratedImagePath(String(parsed.imagePath), context);
      const mimeType = String(parsed.mimeType || 'image/png');
      return {
        buffer: await fs.readFile(imagePath),
        mimeType,
        filename: this.normalizeImageFilename(baseFilename, mimeType, path.basename(imagePath)),
      };
    }

    return null;
  }

  private async saveGeneratedImageLocally(
    filename: string,
    data: Buffer,
    context: { cardId: string; artifactRunId: string },
  ): Promise<string> {
    const cardScope = this.buildArtifactScopeSegment(context.cardId, 'card');
    const runScope = this.buildArtifactScopeSegment(context.artifactRunId, 'run');
    const scopedDir = path.join(GENERATED_IMAGE_DIR, cardScope, runScope);
    await fs.mkdir(scopedDir, { recursive: true });
    const fullPath = path.join(scopedDir, filename);
    await fs.writeFile(fullPath, data);
    return fullPath;
  }

  private buildDemoPdfBuffer(): Buffer {
    return Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n' +
      '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n' +
      '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << >> >>endobj\n' +
      '4 0 obj<< /Length 44 >>stream\nBT /F1 12 Tf 36 150 Td (OpenClaw Demo PDF) Tj ET\nendstream\nendobj\n' +
      'xref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000062 00000 n \n0000000120 00000 n \n0000000240 00000 n \n' +
      'trailer<< /Root 1 0 R /Size 5 >>\nstartxref\n340\n%%EOF\n',
      'utf8'
    );
  }

  private async ensureDemoArtifacts(cardId: string, cardName?: string): Promise<void> {
    const attsBefore = await this.client.getCardAttachments(cardId);
    const hasImageBefore = attsBefore.some(a => String(a.mimeType || '').toLowerCase().startsWith('image/'));
    const hasPdfBefore = attsBefore.some(a => String(a.mimeType || '').toLowerCase() === 'application/pdf');
    const hasLinkBefore = attsBefore.some(a => String(a.url || '').toLowerCase().startsWith('http'));

    if (!hasImageBefore) {
      try {
        const seed = encodeURIComponent(String(Date.now()));
        const prompt = encodeURIComponent('robot lobster cinematic illustration');
        const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=1024&height=1024&seed=${seed}`;
        const res = await fetch(imageUrl);
        if (res.ok) {
          const mimeType = res.headers.get('content-type') || 'image/jpeg';
          const imageBuffer = Buffer.from(await res.arrayBuffer());
          const attach = await this.client.uploadAttachment(cardId, 'robot-lobster-demo-image.jpg', imageBuffer, mimeType);
          try {
            await this.client.setCardCoverToAttachment(cardId, attach.id);
          } catch (_coverErr) {
            // best-effort; marker guard will re-check cover status below
          }
        }
      } catch (_imgErr) {
        // best-effort; marker guard will downgrade if still missing
      }
    }

    if (!hasPdfBefore) {
      try {
        const pdfBuffer = this.buildDemoPdfBuffer();
        await this.client.uploadAttachment(cardId, 'openclaw-demo-report.pdf', pdfBuffer, 'application/pdf');
      } catch (_pdfErr) {
        // best-effort; marker guard will downgrade if still missing
      }
    }

    if (!hasLinkBefore) {
      try {
        const safeCardName = encodeURIComponent((cardName || '').slice(0, 80));
        await this.client.attachLink(cardId, `https://example.com/openclaw-trello-demo?card=${safeCardName}`, 'OpenClaw Demo Reference Link');
      } catch (_linkErr) {
        // best-effort; marker guard will downgrade if still missing
      }
    }

    try {
      const card = await this.client.getCard(cardId);
      if (!(card as any)?.idAttachmentCover) {
        const atts = await this.client.getCardAttachments(cardId);
        const img = atts.find(a => String(a.mimeType || '').toLowerCase().startsWith('image/'));
        if (img?.id) {
          await this.client.setCardCoverToAttachment(cardId, img.id);
        }
      }
    } catch (_coverRetryErr) {
      // best-effort cover set
    }
  }

  private async getBoardMembersForDemo(): Promise<Array<{ id: string; username?: string }>> {
    const boardId = this.getPrimaryBoardId();
    const query = new URLSearchParams({
      key: this.config.auth.apiKey,
      token: this.config.auth.token,
      fields: 'id,username',
      limit: '1000',
    });
    const response = await fetch(`https://api.trello.com/1/boards/${boardId}/members?${query.toString()}`);
    if (!response.ok) {
      throw new Error(`Trello API error ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<Array<{ id: string; username?: string }>>;
  }

  private async ensureDemoOtherMemberAssigned(cardId: string): Promise<boolean> {
    try {
      const card = await this.client.getCard(cardId) as TrelloCard & { idMembers?: string[] };
      const cardMemberIds: string[] = Array.isArray((card as any)?.idMembers) ? ((card as any).idMembers as string[]) : [];
      const boardMembers = await this.getBoardMembersForDemo();
      const boardMemberIds = new Set(boardMembers.map(member => String(member.id || '').trim()).filter(Boolean));

      const hasOtherBoardMemberAlready = cardMemberIds.some((memberId: string) => {
        const normalized = String(memberId || '').trim();
        return normalized && normalized !== this.botMemberId && boardMemberIds.has(normalized);
      });
      if (hasOtherBoardMemberAlready) return true;

      const targetMember = boardMembers.find(member => {
        const memberId = String(member.id || '').trim();
        return memberId && memberId !== this.botMemberId && !cardMemberIds.includes(memberId);
      });
      if (!targetMember?.id) return false;

      await this.client.addMember(cardId, targetMember.id);
      return true;
    } catch (_err) {
      return false;
    }
  }

  private async enforceDemoPassMarkers(cardId: string, text: string): Promise<string> {
    if (!text || !text.includes('DEMO:')) return text;

    let comment = text;
    let card: any = null;
    let atts: Array<{ id: string; url?: string; mimeType?: string }> = [];
    try {
      card = await this.client.getCard(cardId);
      atts = await this.client.getCardAttachments(cardId);
    } catch (_err) {
      return comment;
    }

    if (comment.includes('DEMO:update-members:PASS')) {
      await this.ensureDemoOtherMemberAssigned(cardId);
      try {
        card = await this.client.getCard(cardId);
      } catch (_refreshErr) {
        // keep existing snapshot
      }
    }

    if ((comment.includes('DEMO:attach-outputs:PASS') || comment.includes('DEMO:provider-agnostic:PASS'))) {
      await this.ensureDemoArtifacts(cardId, card?.name);
      try {
        card = await this.client.getCard(cardId);
        atts = await this.client.getCardAttachments(cardId);
      } catch (_refreshErr) {
        // keep prior snapshot
      }
    }

    const hasImage = atts.some(a => String(a.mimeType || '').toLowerCase().startsWith('image/'));
    const hasPdf = atts.some(a => String(a.mimeType || '').toLowerCase() === 'application/pdf');
    const hasLink = atts.some(a => String(a.url || '').toLowerCase().startsWith('http'));
    const hasCover = Boolean((card as any)?.idAttachmentCover);
    const cardMemberIds = Array.isArray((card as any)?.idMembers) ? (card as any).idMembers as string[] : [];
    const hasOtherMember = cardMemberIds.some(memberId => {
      const normalized = String(memberId || '').trim();
      return normalized && normalized !== this.botMemberId;
    });

    const downgrade = (marker: string, reason: string) => {
      if (!comment.includes(marker)) return;
      const pending = marker.replace(':PASS', ':PENDING');
      comment = comment.split(marker).join(pending);
      if (!comment.includes(reason)) {
        comment += `\n${reason}`;
      }
    };

    if (!(hasImage && hasPdf && hasLink && hasCover)) {
      downgrade(
        'DEMO:attach-outputs:PASS',
        'Attachment demo is still in progress: image + PDF + link + cover must all be present before PASS.',
      );
    }

    if (!hasImage) {
      downgrade(
        'DEMO:provider-agnostic:PASS',
        'Provider-agnostic output demo is still in progress: image evidence is required before PASS.',
      );
    }

    if (!hasOtherMember) {
      downgrade(
        'DEMO:update-members:PASS',
        'Member update demo is still in progress: assign at least one other board member to the card before PASS.',
      );
    }

    return comment;
  }
}
