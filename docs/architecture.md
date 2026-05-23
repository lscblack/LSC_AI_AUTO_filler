# Architecture

## Goals

The platform is designed to help users apply faster without losing control of tone, accuracy, or grounding. The first implementation goal is not full autonomy. It is a reliable decision loop that can detect forms, map questions to user evidence, generate grounded suggestions, and ask for confirmation when confidence is low.

## System shape

### Browser extension

The extension owns page observation and user interaction:

- Detect forms, labels, textareas, selects, radio groups, contenteditable editors, and shadow DOM surfaces.
- Build a form snapshot that captures the field metadata, site context, and page hints.
- Send snapshots to the local AI backend.
- Receive deterministic fills and contextual drafts.
- Preserve a review-first workflow before submission.

### Local AI backend

The backend owns reasoning and memory:

- Normalize uploaded documents into a user profile.
- Store persistent application history and answer preferences.
- Analyze form intent and classify fields by fill strategy.
- Generate grounded responses from the profile, job description, and site context.
- Prefer local inference through Ollama when available.
- Fall back to deterministic heuristics when a model is unavailable or the prompt is low confidence.

### Shared contract layer

Shared schemas prevent the browser and backend from drifting apart. This is important because the extension and server will evolve independently.

## Reasoning flow

1. The content script scans the page and creates a snapshot.
2. The background worker forwards that snapshot to the local API.
3. The API analyzes fields and identifies deterministic versus contextual questions.
4. The answer engine looks up profile facts, prior applications, and job context.
5. Drafts are returned with confidence and grounding notes.
6. The extension shows or applies values only after the user approves low-trust actions.

## Memory model

The memory system is layered:

- Raw documents: resumes, CVs, certificates, portfolios, and job descriptions.
- Structured profile: normalized facts, skills, experience highlights, education, and preferences.
- Application history: what was answered, where it was used, and whether the user accepted or edited it.
- Answer memory: prior phrasing that the user accepted so future answers stay consistent.

## Security posture

- Local first by default.
- Explicit user approval before submission.
- No hallucinated claims: every generated response must be grounded in user evidence or labeled as a draft.
- Keep host permissions narrow when the browser package is hardened for release.
