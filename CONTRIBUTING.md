# Contributing

## Scope

This plugin is maintained in the Underlord infrastructure repository and deployed into OpenClaw runtime from canonical source files.

## Development Workflow

1. Modify canonical sources in:
- `docker/services/openclaw/plugins/openclaw-plugin-trello/src/index.ts`
- `docker/services/openclaw/plugins/openclaw-plugin-trello/src/client.ts`
- `docker/services/openclaw/plugins/openclaw-plugin-trello/src/tools.ts`

2. Keep runtime mirror file in sync when required:
- `tmp/openclaw-plugin-trello-runtime-index.js`

3. Validate behavior:
- `scripts/verify-trello-plugin-workflows.sh`
- `scripts/test-trello-plugin-regression.sh`

4. Deploy to running container for runtime validation:
- copy canonical source into `/home/node/.openclaw/extensions/openclaw-plugin-trello/src/`
- build in-container (`npm run build`)
- restart `openclaw`

## Commit Hygiene

- Stage only relevant files.
- Use focused commit messages (example: `trello: <scope>`).
- Do not push failing or partial work.

## Release and Rollback

Follow:
- `docs/openclaw-plugin-trello-release-checklist.md`
