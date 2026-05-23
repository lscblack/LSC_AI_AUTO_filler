import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ApplicantProfileSchema, FormSnapshotSchema } from '@lsc-ai/shared';
import { composeDraftAnswer } from './engine/answer-engine.js';
import { analyzeForm } from './engine/form-analyzer.js';
import { listOllamaModels } from './engine/ollama.js';
import { buildApplicantProfile } from './engine/profile-builder.js';
import { DraftAnswerRequestSchema, ProfileIngestRequestSchema } from './schemas.js';
import { appendHistory, ingestDocuments, loadStore } from './store/application-store.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  credentials: true
});

const initialStore = await loadStore();
let currentProfile = initialStore.currentProfile;
const applicationHistory: Array<Record<string, unknown>> = [...initialStore.history];

app.get('/health', async () => {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_MODEL ?? 'llama3.1';
  let ollamaReachable = false;
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    ollamaReachable = res.ok;
  } catch { /* unreachable */ }
  return { ok: true, service: 'lsc-ai-api', model: ollamaReachable ? model : null, ollamaReachable };
});

app.get('/v1/profile/current', async () => ({ profile: currentProfile }));

app.get('/v1/models', async () => {
  const models = await listOllamaModels();
  return { models };
});

app.post('/v1/profile/ingest', async (request, reply) => {
  const parsed = ProfileIngestRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid profile ingest request', issues: parsed.error.issues });
  }

  try {
    const store = await ingestDocuments(parsed.data);
    currentProfile = store.currentProfile;
    applicationHistory.push(...store.history.slice(-1));
    return reply.send({ profile: currentProfile });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    request.log.error({ err }, 'ingestDocuments failed');
    return reply.status(500).send({ error: 'Document processing failed', detail: message });
  }
});

app.post('/v1/forms/analyze', async (request, reply) => {
  const parsed = FormSnapshotSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid form snapshot', issues: parsed.error.issues });
  }

  const analysis = analyzeForm(parsed.data);
  const analysisEntry = { type: 'form.analysis', snapshotId: analysis.snapshotId, siteHost: analysis.siteHost, timestamp: new Date().toISOString() };
  applicationHistory.push(analysisEntry);
  await appendHistory(analysisEntry);

  return reply.send({ analysis });
});

app.post('/v1/answers/draft', async (request, reply) => {
  const parsed = DraftAnswerRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid draft request', issues: parsed.error.issues });
  }

  const draft = await composeDraftAnswer(parsed.data);
  const draftEntry = {
    type: 'answer.draft',
    question: parsed.data.question,
    shouldReview: draft.shouldReview,
    confidence: draft.confidence,
    timestamp: new Date().toISOString()
  };
  applicationHistory.push(draftEntry);
  await appendHistory(draftEntry);

  return reply.send({ draft });
});

app.get('/v1/history', async () => ({ history: applicationHistory.slice(-100) }));

const port = Number(process.env.PORT ?? 4317);

if (import.meta.url === `file://${process.argv[1]}`) {
  await app.listen({ port, host: '0.0.0.0' });
}

export { app };
