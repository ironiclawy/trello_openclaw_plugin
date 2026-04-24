# Changelog

All notable changes to openclaw-plugin-trello are documented in this file.

## 1.0.0 - 2026-04-17

### Added
- Webhook ingress dedupe and inflight guards with bounded cache controls.
- Artifact isolation for generated image attachments using card/run-scoped storage.
- Stable workflow operation contract validation (`v1.0.0`) with allow-list and type checks.
- Expanded regression gate required checks for runtime contract/isolation markers.
- Machine-readable regression summary output (`Regression summary (json)` and optional file artifact via `TRELLO_REGRESSION_SUMMARY_FILE`).

### Changed
- Webhook ingress fail-closed checks now accept valid responses as `200` or dedupe/inflight `202`.
- Startup list behavior uses existing board state and avoids automatic list creation.

### Operational Notes
- Use `scripts/test-trello-plugin-regression.sh` before and after plugin changes.
- Use `docs/openclaw-plugin-trello-release-checklist.md` for release and rollback execution.
