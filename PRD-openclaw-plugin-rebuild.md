# OpenClaw Trello Plugin Rebuild PRD (Power-Up Excluded)

## 1. Document Status
- Owner: OpenClaw + Trello plugin team
- Scope: Rebuild the OpenClaw Trello plugin from scratch
- Explicitly out of scope: Trello Power-Up UI/features/routes
- Primary runtime target: OpenClaw container extension runtime
- Last updated: 2026-04-25

## 2. Product Summary
Build a production-grade Trello automation plugin that monitors board/card/list/checklist/comment changes and executes deterministic card workflows through:
- Prompt card instructions
- Agent dispatch to OpenClaw models
- Structured workflow JSON contract
- Demo script deterministic scenarios for testability

The rebuilt plugin must be resilient against duplicate events, replay storms, race conditions, and noisy webhook traffic while preserving user intent and card safety.

## 3. Goals
1. Reliably detect and process relevant Trello card events in near real time.
2. Route cards to the correct OpenClaw agent by label/default routing.
3. Support both freeform agent responses and structured workflow execution.
4. Support user comment follow-ups as first-class events.
5. Enforce safety around cross-card writes and malformed workflows.
6. Provide deterministic demo workflows for onboarding and regression tests.
7. Expose sufficient observability to diagnose race, dedupe, timeout, and auth issues.

## 4. Non-Goals
- Trello Power-Up board buttons/modal/settings/stats UX.
- Generic project management features outside Trello card automation.
- Multi-tenant ACL orchestration beyond per-board/plugin config.

## 5. Users and Primary Use Cases
- Operator: configures plugin auth, watched boards/lists, and routing.
- End user: writes a card title/description or comment; expects automation response.
- Demo operator: seeds deterministic cards and validates behavior quickly.

Key use cases:
1. New card intake in watched list -> route to agent -> execute actions.
2. Card moved across watched lists -> re-open eligibility and re-process as needed.
3. User comment follow-up on active card -> continue workflow without re-init noise.
4. Deterministic canned demos for travel, expenses, social launch, pricing reply, dinner booking.

## 5.1 User Stories

### 5.1.1 End User Stories

Story EU-1: New Card Intake
- As a Trello user, I want a newly created card in a watched list to trigger automation automatically so that I do not need to manually invoke an agent.
- Acceptance criteria:
  - A `createCard` event for a watched board/list is ingested and acknowledged.
  - The card is routed to an agent using label/default routing.
  - A user-visible result comment or workflow side-effect appears on the same card.

Story EU-2: User Comment Follow-Up
- As a Trello user, I want my follow-up comment to continue the active workflow so that I can refine or approve work conversationally.
- Acceptance criteria:
  - A non-automation `commentCard` event routes to follow-up processing.
  - Follow-up does not reinitialize unrelated setup steps.
  - Response reflects the latest user comment context.

Story EU-3: Ignore Automation Echoes
- As a Trello user, I want only human comments to trigger automations so that bot comments do not cause loops.
- Acceptance criteria:
  - Comments by bot/automation members are ignored.
  - Missing-author or empty comments are ignored.
  - Logs include explicit ignore reason markers.

Story EU-4: Deterministic Flight Confirmation Flow
- As a Trello user, I want flight option cards to ask me for confirmation and then complete when I confirm so that booking decisions are explicit.
- Acceptance criteria:
  - Flight demo card posts structured options and booking links.
  - User confirmation phrases (for example, option-based or time confirmation variants) map to completion workflow.
  - Card membership behavior matches scenario contract.

Story EU-5: Clean Completion Messaging
- As a Trello user, I want completion comments to be concise and non-duplicative so that card activity remains readable.
- Acceptance criteria:
  - Duplicate terminal comments within dedupe window are suppressed.
  - Partial failures produce a clear partial-completion signal.
  - Repeated event replays do not spam identical completion comments.

### 5.1.2 Operator Stories

Story OP-1: Prompt Card Governance
- As an operator, I want list-level prompt card instructions applied automatically so that teams can enforce list-specific operating policy.
- Acceptance criteria:
  - Prompt card instructions are appended to dispatch context with a clear marker.
  - Prompt instruction cards themselves are excluded from normal task intake.
  - Failures to fetch prompt cards do not crash the event loop.

Story OP-2: Safe Cross-Card Writes
- As an operator, I want cross-card writes blocked by default so that accidental broad updates are prevented.
- Acceptance criteria:
  - Operations target base card unless `allowCrossCard=true`.
  - Cross-card operation without explicit opt-in is rejected with clear error.
  - Optional environment override is auditable and explicit.

Story OP-3: Resilient Webhook Operations
- As an operator, I want webhook ingestion to be replay-safe and race-safe so that duplicate deliveries do not duplicate work.
- Acceptance criteria:
  - Action-key dedupe cache drops repeated webhook actions within TTL.
  - Inflight guard prevents concurrent execution of same action key.
  - Metrics/logs show accepted, deduped, dropped, and retried counts.

Story OP-4: Token/Auth Robustness
- As an operator, I want gateway token resolution to work in containerized runtime layouts so that dispatch does not fail on path drift.
- Acceptance criteria:
  - Token resolves from env first, then canonical runtime config locations.
  - Missing token fails with explicit diagnostic.
  - Normal dispatch succeeds without requiring manual shell intervention per event.

Story OP-5: Controlled Demo Experience
- As an operator, I want deterministic demo scenarios so that onboarding and regression demos are repeatable.
- Acceptance criteria:
  - Demo pattern matches return scripted workflow payloads.
  - Each canonical demo card has expected deterministic side-effects.
  - Demo verification scripts can assert pass/fail automatically.

### 5.1.3 Developer Stories

Story DEV-1: Contract-First Workflow Engine
- As a plugin developer, I want strict workflow contract validation so that malformed agent JSON cannot execute unsafe operations.
- Acceptance criteria:
  - Unknown keys/op names are rejected before execution.
  - Type validation errors identify operation index and field.
  - Legacy aliases remain supported only where intentionally defined.

Story DEV-2: Idempotent Attachment Semantics
- As a plugin developer, I want attachment operations to be idempotent so that retries do not duplicate links/files.
- Acceptance criteria:
  - Existing link/file checks prevent duplicate attachments on replay.
  - Cover-setting logic still works when attachment already exists.
  - Operation result details indicate skipped-vs-created behavior.

Story DEV-3: Diagnoseable Failure Modes
- As a plugin developer, I want high-signal logs and counters so that production issues can be debugged quickly.
- Acceptance criteria:
  - Dispatch retry/timeout/error reasons are logged with context.
  - Routing decisions (`move`, `comment`, ignored reasons) are traceable.
  - Session/dispatch usage counters are available for incident analysis.

## 6. Functional Requirements

### 6.1 Event Ingestion
- Accept Trello webhook events for:
  - createCard
  - commentCard
  - updateCard list moves
  - createCheckItem (for checklist-item-specific automation)
- Validate webhook payload and auth fail-closed.
- Handle HEAD webhook probes.
- Maintain bounded dedupe cache for webhook action IDs.
- Prevent concurrent duplicate execution for same action key.

### 6.2 Watch Scope and Discovery
- Resolve and watch one or more board IDs.
- Resolve list filters from config/env.
- Support card-name regex watch filters.
- Run backlog polling recovery loop to catch missed webhooks.
- Treat cards in watched lists as eligible for processing.

### 6.3 Routing and Prompt-Card System
- Resolve target agent from card labels or fallback default agent.
- Fetch list-level Prompt card instructions and append to dispatch context.
- Enforce that Prompt card text is treated as operating constraints, not direct user request.
- Do not require user to manually repeat prompt card instructions.

### 6.4 Comment Handling (User-Only)
- Process only user-authored comments for routing.
- Ignore comment events when:
  - author is missing
  - author is bot member
  - author is any configured automation member on that board
  - comment text is empty
- Preserve follow-up behavior even when session store is short-lived.

### 6.5 Workflow Contract
- Accept structured JSON payload:
  - type=workflow
  - operations[]
- Validate:
  - allowed ops
  - allowed keys
  - type constraints
  - nullability constraints
- Reject unknown keys/op names with clear error detail.

Supported operation families:
- Card flow: move_card, mark_complete, archive_card, update_description
- Membership: assign_self, add_member, remove_member, set_members, add_creator_member
- Labels: add_label, remove_label
- Checklist: add_checklist_item, update_checklist_item, complete_checklist_item
- Comments: add_comment, update_comment
- Attachments: attach_link, attach_remote_file
- Dates: set_dates

### 6.6 Cross-Card Safety
- Default all operations to base card.
- Cross-card targeting by cardName requires explicit per-op allowCrossCard=true.
- Optional operator override via env (still auditable).

### 6.7 Agent Dispatch
- Send chat-completions request to local OpenClaw gateway.
- Include system prompt tuned for card context.
- Include list instruction system message when available.
- Use timeout tiers:
  - default text timeout
  - image timeout
  - PDF timeout
  - complex workflow timeout
- Retry aborted requests with bounded attempts and extended timeout.

### 6.8 Token/Auth Resolution
- Resolve gateway token from environment first, then runtime config fallbacks.
- Support canonical openclaw.json locations in containerized runtime.
- Fail with explicit diagnostic when token unavailable.

### 6.9 Attachments and Artifacts
- Support link attachments and remote file uploads.
- Support optional setAsCover for remote file/image.
- Use artifact scoping (card/run specific) and fail closed when artifact path invalid.
- Enforce idempotency where possible (avoid duplicate attachments on replay).

### 6.10 Completion Messaging
- Build final user-visible completion comments from workflow results.
- Suppress duplicate final comments in short dedupe window.
- Keep comments concise and human-readable.

### 6.11 Demo Script System
- Match deterministic regex patterns and return canned workflow payloads instead of live dispatch.
- Current required demo scenarios:
  - flight-star-alliance-austin
  - concur-expenses-las-vegas
  - product-launch-announcement
  - customer-pricing-response
  - dinner-booking-romantic-italian
  - dinner-booking-confirmation

Behavioral specifics to preserve:
- Flight: add user to card, attach booking links, ask for option confirmation.
- Expense: do not add user; generate expense checklist + Concur link + mark complete.
- Social launch: launch checklist + GIF + summary comment; no generic long-task progress checklist.
- Pricing: write drafted email into description and mark complete.
- Dinner booking: use real Palo Alto target (Terun), links, cover, assign user, ask confirmation.
- Dinner confirmation: react to natural language variants (approved/sounds good/is great/works at 7pm) and mark complete.

## 7. Non-Functional Requirements

### 7.1 Reliability
- At-least-once event semantics with dedupe and idempotency controls.
- Graceful degradation under transient Trello/API/gateway failures.

### 7.2 Performance
- Webhook handler must ACK quickly; heavy work async after response.
- Poll loops bounded by configurable intervals and guarded against overlap.

### 7.3 Observability
- Structured log markers for:
  - webhook accepted/deduped/dropped/retried
  - move/comment routing decisions
  - dispatch starts/errors/retries
  - workflow validation/operation failures
  - duplicate comment suppression
- Metrics object for sessions, dispatches, per-agent usage.

### 7.4 Security
- Webhook auth verification token/HMAC support.
- No plaintext secrets committed.
- Minimal write scope and explicit cross-card opt-in.

## 8. State Model and Internal Queues

### 8.1 In-Memory State
- webhookSeenEvents map: dedupe TTL for action keys.
- webhookInFlightEvents set: prevent concurrent duplicate processing.
- store/session map by card: recent history and context.
- activeRoutedCards set: prevent same-card overlap while processing.
- lastRoutedFingerprintByCardId: short-window replay suppression.
- watchedBoardIds and watchedListIdsByBoardId caches.

### 8.2 Background Loops
- Backlog poll loop: discovers eligible cards missed by webhook.
- Recovery loop: reopens intake eligibility after list transitions.
- Optional shopping automation loop/checklist loop.

No external queue broker is required initially; if scale exceeds single runtime capacity, migrate processing behind a durable queue with per-card ordering keys.

## 9. Race Conditions and Gotchas

### 9.1 Duplicate Triggers
- Same action can arrive via webhook + poll in close succession.
- Mitigation: action dedupe key + inflight lock + per-card active routing guard.

### 9.2 Session Lifecycle
- Session may be deleted after each run; follow-up comments can appear as "new".
- Mitigation: treat valid commentCard events as follow-ups and parse "New User Comment" section for demo matching.

### 9.3 Bot Echo Loops
- Automation comments can trigger new comment events.
- Mitigation: strict ignore of automation-authored comments.

### 9.4 Event Payload Shape Variability
- Some comment events may have missing author data or board/model fields.
- Mitigation: reject safely when author missing; best-effort board resolution.

### 9.5 Card Creation Variants
- Copied cards may emit copyCard instead of createCard.
- Mitigation: creator-resolution logic must inspect createCard and copyCard-like action types.

### 9.6 Attachment Replays
- Retries can duplicate links/files.
- Mitigation: compare existing attachments by URL/name before attaching.

### 9.7 Token Path Drift
- Container cwd-based config path can be wrong.
- Mitigation: canonical config path fallback and env token fallback.

### 9.8 Human-Friendly Confirmation Parsing
- User says "7pm works" not "confirm booking".
- Mitigation: pattern library must include natural variants.

## 10. Prompt Card Behavior Requirements
- Prompt card is list-scoped policy, not user message.
- Prompt card text appended in a dedicated marker block.
- Prompt card fetch failures must not crash entire processing loop.
- Prompt instruction cards themselves must be excluded from normal intake.

## 11. Error Handling and User Messaging
- On operation-specific failure, continue remaining operations when safe and summarize partial completion.
- On hard dispatch failure, post concise error comment once.
- Do not spam repeated identical terminal comments.

## 12. Configuration and Environment
Required plugin config:
- auth.apiKey
- auth.token
- boardId
- webhookCallbackUrl

Core optional config:
- lists.backlog, lists.inProgress, lists.done
- agentLabels
- defaultAgent
- shoppingAutomation subtree
- interimResponseThresholdMs

Key env controls:
- TRELLO_WEBHOOK_DEDUPE_TTL_MS
- TRELLO_WEBHOOK_DEDUPE_MAX_SIZE
- TRELLO_WEBHOOK_METRICS_LOG_INTERVAL_MS
- TRELLO_BACKLOG_POLL_INTERVAL_MS
- TRELLO_BACKLOG_RECOVERY_RECHECK_MS
- TRELLO_ALLOW_CROSS_CARD_WORKFLOW
- TRELLO_AGENT_TIMEOUT_MS
- TRELLO_AGENT_TIMEOUT_IMAGE_MS
- TRELLO_AGENT_TIMEOUT_PDF_MS
- TRELLO_AGENT_TIMEOUT_COMPLEX_MS
- TRELLO_API_RETRY_ATTEMPTS
- TRELLO_API_RETRY_BASE_MS
- TRELLO_API_RETRY_MAX_MS
- TRELLO_WEBHOOK_VERIFY_TOKEN
- TRELLO_WEBHOOK_APP_SECRET

## 13. Testing and Validation Plan

### 13.1 Test Layers
1. Unit tests
- Workflow contract validation
- Prompt card extraction/formatting
- Dedup/fingerprint utilities
- Author filtering rules for comment events

2. Integration tests (containerized)
- Webhook auth and payload validation
- End-to-end event ingestion -> route -> workflow execution
- Retry/backoff behavior against mocked Trello/gateway errors
- Cross-card protection

3. Regression scripts
- scripts/verify-trello-plugin-workflows.sh
- scripts/test-trello-plugin-regression.sh

4. Demo seed/verify flows
- scripts/seed-trello-demo.sh
- scripts/run-trello-demo.sh
- scripts/verify-trello-demo.sh
- lite variants for lower-cost validation

### 13.2 Demo Boards and Cards (Required Fixtures)
Maintain at least one shared demo board with canonical cards:
- Book flights for the customer meeting in Austin
- Las Vegas tradeshow expenses
- Announce the new TrelloClaw product launch
- Respond to the customer with the latest pricing page
- Book dinner at a romantic Italian restaurant for our anniversary

Each demo card should have:
- Deterministic trigger text
- Expected resulting attachments/checklists/comments
- A verifier that asserts pass markers and no duplicate side effects

### 13.3 Failure Injection Scenarios
- Missing gateway token
- Trello 429/503 bursts
- Duplicate webhook replay
- Bot-authored comment loops
- copyCard creator-resolution path
- Concurrent comment + list move on same card

## 14. Rollout Plan
1. Implement feature parity in shadow mode (log-only decisions where risky).
2. Enable live writes on demo board only.
3. Run regression + seeded demo suite.
4. Expand to production watched boards with tight logging.
5. Keep rollback plan: restore previous runtime source files and restart.

## 15. Acceptance Criteria
- User comments (non-automation authors) are reliably routed and answered.
- Automation-authored comments never trigger new runs.
- Duplicate webhook events do not produce duplicate actions/comments.
- Demo scenarios execute deterministically with expected outputs.
- No Power-Up dependencies required for core plugin operation.
- Operator can diagnose failures from logs without source dive.

## 16. Open Decisions
- Whether to introduce durable queueing for high-volume boards.
- Whether partial-completion comments should include per-op failure details by default.
- Whether demo scripts should be tenant-configurable at runtime.
- Whether to persist dedupe/session state across process restarts.
