# LSC AI Auto Filler

An AI job application assistant platform that combines a browser extension, local-first AI reasoning, and persistent application memory.

## What this scaffold includes

- A bundled browser extension shell for form detection and background orchestration.
- A local Fastify API for form analysis, profile synthesis, and answer generation.
- Shared TypeScript contracts so the extension and backend use the same request and response models.
- A documented architecture and implementation roadmap.

## Initial architecture

- `apps/extension`: scans application forms, classifies field intent, and sends snapshots to the backend.
- `apps/api`: runs local reasoning, falls back to Ollama when available, and manages application memory.
- `packages/shared`: shared schemas, types, and normalization helpers.

## Commands

- `pnpm install`
- `pnpm dev:api`
- `pnpm dev:extension`
- `pnpm build`
