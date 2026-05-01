# openclaw-plugin-trello Standalone Plugin and Overlay Guide

Canonical source for the OpenClaw Trello plugin.

This repository now contains a self-contained plugin package (including internal modules and build metadata), and can also still be used as an overlay source for an already-installed runtime extension.

## Scope

This folder stores the maintained plugin source files used for standalone builds and runtime overlays.

Current managed files:
- `src/index.ts`
- `src/client.ts`
- `src/tools.ts`
- `src/demo-script.ts`
- `src/webhook.ts`

## Installation Paths

Use one of these installation paths depending on your environment.

### Path A: Standalone Plugin Install (Recommended for Fresh Hosts)

Use this on a new VPS/host when you want this repository to be the source of truth.

1. Clone this repository on the target host.
2. Install dependencies.
3. Build the plugin.
4. Copy resulting source/dist into your OpenClaw extension location (or replace existing extension tree).
5. Restart OpenClaw.

Example:

```bash
git clone https://github.com/<your-org>/trello_openclaw_plugin.git
cd trello_openclaw_plugin
npm ci
npm run build

# Example runtime install path:
mkdir -p /home/node/.openclaw/extensions/openclaw-plugin-trello
rsync -a --delete ./ /home/node/.openclaw/extensions/openclaw-plugin-trello/

# restart your OpenClaw service/container here
```

### Path B: Existing Runtime Overlay (Current Method)

Use this when your OpenClaw instance already has a working `openclaw-plugin-trello` extension tree.

1. Copy managed source files into the existing runtime extension directory.
2. Build extension code in place.
3. Restart OpenClaw.

Example:

```bash
docker cp src/index.ts openclaw:/home/node/.openclaw/extensions/openclaw-plugin-trello/src/index.ts
docker cp src/client.ts openclaw:/home/node/.openclaw/extensions/openclaw-plugin-trello/src/client.ts
docker cp src/tools.ts openclaw:/home/node/.openclaw/extensions/openclaw-plugin-trello/src/tools.ts
docker cp src/demo-script.ts openclaw:/home/node/.openclaw/extensions/openclaw-plugin-trello/src/demo-script.ts
docker cp src/webhook.ts openclaw:/home/node/.openclaw/extensions/openclaw-plugin-trello/src/webhook.ts

docker exec openclaw sh -lc 'cd /home/node/.openclaw/extensions/openclaw-plugin-trello && npm run build'
docker restart openclaw
```

### Path C: Base-Extension Bootstrap from Known-Good Runtime

Use this when you want to clone an already-proven runtime extension tree exactly (for fast migration parity).

Important:
- This is a migration shortcut, not a requirement for fresh installs.
- If you use Path A, this repository already contains the modules needed for a standalone build.

Recommended bootstrap flow:

1. Seed a full plugin extension directory from a known-good OpenClaw instance.

Source host:

```bash
docker exec openclaw sh -lc 'cd /home/node/.openclaw/extensions && tar -czf /tmp/openclaw-plugin-trello-full.tgz openclaw-plugin-trello'
docker cp openclaw:/tmp/openclaw-plugin-trello-full.tgz ./openclaw-plugin-trello-full.tgz
```

2. Transfer `openclaw-plugin-trello-full.tgz` to the target host.

3. Extract on target host into OpenClaw extension path.

Target host:

```bash
mkdir -p /home/node/.openclaw/extensions
tar -xzf openclaw-plugin-trello-full.tgz -C /home/node/.openclaw/extensions
```

4. Apply this repo's managed overrides to that full plugin tree.

```bash
cp src/index.ts /home/node/.openclaw/extensions/openclaw-plugin-trello/src/index.ts
cp src/client.ts /home/node/.openclaw/extensions/openclaw-plugin-trello/src/client.ts
cp src/tools.ts /home/node/.openclaw/extensions/openclaw-plugin-trello/src/tools.ts
cp src/demo-script.ts /home/node/.openclaw/extensions/openclaw-plugin-trello/src/demo-script.ts
cp src/webhook.ts /home/node/.openclaw/extensions/openclaw-plugin-trello/src/webhook.ts
```

5. Build and restart OpenClaw.

```bash
cd /home/node/.openclaw/extensions/openclaw-plugin-trello
npm run build
# restart your OpenClaw service/container here
```

Quick sanity check before build (fresh host):

```bash
ls /home/node/.openclaw/extensions/openclaw-plugin-trello/src/auth
ls /home/node/.openclaw/extensions/openclaw-plugin-trello/src/router.ts
```

If those do not exist, your base plugin seed is incomplete.

Demo scripting:
- `src/demo-script.ts` defines canned prompt-to-workflow mappings for repeatable mock demos.
- If an incoming card prompt matches a configured demo script pattern, the plugin executes scripted workflow operations instead of dispatching to the live agent model.

## Capability Matrix

- Watch lists by name: supported via `TRELLO_WATCH_LIST_NAMES` (comma-separated list names).
- Watch cards by name: supported via `TRELLO_WATCH_CARD_NAME_REGEX` (case-insensitive regex).
- Watch and update checklists: supported (rename and mark complete operations).
- Update labels: supported (add and remove labels).
- Attach plugin account user to card: supported (`assign_self`/`attach_self`, from auth token identity).
- Update dates: supported (`set_dates` for start, due, dueComplete).
- Update members: supported (add, remove, replace full member list).
- Move cards across lists: supported (`move_card`).
- Archive cards: supported (`archive_card`).
- Mark cards as complete: supported (`mark_complete`, sets `dueComplete` and can move to Done).
- Watch comments and respond: supported through webhook routing + agent responses; comments can also be updated with `update_comment` workflow op.
- Attach outputs as attachment: supported for images, PDFs, and link attachments.
- LLM provider agnostic: supported via agent artifact-first image flow with fallback providers (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`).
- Combine skills into custom workflow: supported with agent JSON contract `{"type":"workflow","operations":[...]}`.

## Workflow JSON Contract

Contract version: `v1.0.0`

Validation behavior:
- Unknown keys in workflow operations are rejected.
- Unsupported operation names are rejected.
- Core field types are validated before execution (for example: `allowCrossCard` must be boolean, `memberIds` must be string array).
- Legacy aliases `text` and `matchText` are still accepted for compatibility.

The agent may return this payload to combine multiple Trello actions in one run:

```json
{
	"type": "workflow",
	"operations": [
		{ "op": "assign_self" },
		{ "op": "add_label", "labelName": "Ready to checkout" },
		{ "op": "set_dates", "due": "2026-04-20T17:00:00.000Z" },
		{ "op": "move_card", "listName": "Done" }
	]
}
```

Supported `op` values:

- `assign_self` / `attach_self`
- `move_card`
- `set_dates`
- `add_member`
- `remove_member`
- `set_members`
- `add_label`
- `remove_label`
- `update_checklist_item` (use `checklistItemName` + `checklistItemNewName`)
- `complete_checklist_item`
- `add_comment`
- `update_comment` (uses `commentMatchText` to locate existing comment)
- `attach_link`
- `mark_complete`
- `archive_card`

Workflow scope safety:
- Operations default to the current/base card.
- Cross-card targeting by `cardName` requires explicit opt-in per operation: `"allowCrossCard": true`.
- Optional global override for operators: `TRELLO_ALLOW_CROSS_CARD_WORKFLOW=true`.

Attachment artifact isolation:
- Generated image artifacts are stored in card/run-scoped paths under `GENERATED_IMAGE_DIR`.
- Shared nearest-file fallback recovery is intentionally disabled.
- If a provided `imagePath` is missing outside the scoped location, the attachment step fails closed.

## Verification

Use [scripts/verify-trello-plugin-workflows.sh](scripts/verify-trello-plugin-workflows.sh) from repo root to execute requirement-level checks and emit pass/fail results.

For tests-first safety baselining, run the regression gate before and after any hardening change:

```bash
scripts/test-trello-plugin-regression.sh
```

Use strict mode to fail on optional regressions too:

```bash
scripts/test-trello-plugin-regression.sh --strict
```

Current required checks in regression gate:
- Workflow capability verifier.
- Webhook ingress fail-closed (accept valid webhook responses as `200` or `202` under dedupe/inflight behavior).
- Workflow contract validation markers present in runtime source/dist.
- Artifact isolation markers present in runtime source/dist.

### OpenClaw Demo (Onboarding-Friendly)

Use a compact single-card demo run that showcases the full capability set in one place:

```bash
scripts/seed-trello-demo.sh
```

This prints a `runId` and card URL for:

- `OpenClaw Demo <runId>`

Optionally run the deterministic completer to finish the card end-to-end without waiting on live agent variability:

```bash
scripts/run-trello-demo.sh <runId>
```

Verify that run with:

```bash
scripts/verify-trello-demo.sh <runId>
```

This is intended for onboarding demos and repeatable regression checks with explicit PASS markers in card comments, while keeping demo cards visible for end users.

### OpenClaw Lite Demo (Low-Cost Test Card)

Use this lightweight variant for frequent validation when you want to avoid image/PDF generation cost:

```bash
scripts/seed-trello-demo-lite.sh
```

This prints a `runId` and card URL for:

- `OpenClaw Demo Lite <runId>`

Run deterministic completion:

```bash
scripts/run-trello-demo-lite.sh <runId>
```

Verify that run with:

```bash
scripts/verify-trello-demo-lite.sh <runId>
```

The lite demo validates core routing/workflow behavior without rich-output attachment requirements.

## Trello Power-Up Board Modal (Stats)

A starter Power-Up bundle is included at:

- `powerup/connector.html`
- `powerup/client.js`
- `powerup/modal.html`
- `powerup/modal.js`

What it does:

- Adds a `board-buttons` entry named `OpenClaw Stats`.
- Opens a Trello `t.modal(...)` iframe on click.
- Fetches live stats from plugin route: `GET /trello/powerup/stats`.
- Adds `show-settings` support so board admins can configure endpoint/token per board.
- Supports setup automation endpoints:
	- `POST /trello/powerup/setup-card`
	- `POST /trello/powerup/setup-import`

Stats payload currently includes:

- Session counts (`started`, `active`, `completed`, `failed`).
- Dispatch counts/errors.
- Token usage totals (`prompt`, `completion`, `total`).
- Per-agent usage table.

Optional endpoint protection:

- Set `TRELLO_POWERUP_STATS_TOKEN` in OpenClaw env.
- Configure the connector URL with `statsToken` query arg so modal requests include it.

Example connector URL in Trello Power-Up admin:

```text
https://<your-static-host>/openclaw-plugin-trello/powerup/connector.html
```

Optional creator defaults (board config can override):

```text
https://<your-static-host>/openclaw-plugin-trello/powerup/connector.html?statsUrl=https%3A%2F%2F<your-openclaw-host>%2Ftrello%2Fpowerup%2Fstats&statsToken=<token-if-enabled>
```

Board-admin setup flow (recommended):

1. Open Power-Up settings (gear icon).
2. Click `Create Setup Card`.
3. Edit setup card description values (`OPENCLAW_STATS_URL`, optional token/name).
4. Paste setup card ID in settings and click `Import + Archive`.
5. Imported config is stored as board shared Power-Up data (`openclawStatsConfig`).

Notes:

- Power-Up assets must be hosted over HTTPS.
- This bundle is framework-free by design for fast customization.

## Apply Workflow

From repo root, sync `src/` files to your plugin runtime source directory using your preferred deployment process, then rebuild/reload the runtime.

## Notes

- Plugin startup resolves against existing board lists and does not auto-create configured list names.
- Prefer agent artifact image outputs (`imagePath`, `imageUrl`, `imageBase64`) before provider-key fallback generation.
- Trello API calls use bounded retry/backoff for transient failures (`408`, `429`, and `5xx`) plus network transport errors.
- Optional retry tuning env vars:
	- `TRELLO_API_RETRY_ATTEMPTS` (default `3`)
	- `TRELLO_API_RETRY_BASE_MS` (default `300`)
	- `TRELLO_API_RETRY_MAX_MS` (default `5000`)
