import type { FormSnapshot } from '@lsc-ai/shared';

export interface AnalysisResponse {
  analysis: {
    snapshotId: string;
    needsHumanReview: boolean;
    suggestions: Array<{
      fieldId: string;
      strategy: 'deterministic' | 'contextual' | 'manual_review';
      confidence: number;
      reason: string;
      proposedValue?: string;
    }>;
  };
}

const LOCAL_API_URL = 'http://127.0.0.1:4317';
const SESSION_PREFIX = 'lsc-ai-auto-filler';

// import.meta.url is chrome-extension://[id]/dist/background.js when the extension
// is loaded from the source root (apps/extension/), and chrome-extension://[id]/background.js
// when loaded from the dist/ folder directly.  Use this to open the right popup.html.
const POPUP_HTML = new URL(import.meta.url).pathname.startsWith('/dist/')
  ? 'dist/popup.html'
  : 'popup.html';

async function getStoredSnapshots(): Promise<FormSnapshot[]> {
  const result = await chrome.storage.local.get(`${SESSION_PREFIX}:snapshots`);
  return (result[`${SESSION_PREFIX}:snapshots`] ?? []) as FormSnapshot[];
}

async function storeSnapshot(snapshot: FormSnapshot): Promise<void> {
  const snapshots = await getStoredSnapshots();
  const next = [...snapshots.filter((item) => item.formId !== snapshot.formId), snapshot].slice(-25);
  await chrome.storage.local.set({ [`${SESSION_PREFIX}:snapshots`]: next });
}

async function storeAnalysis(formId: string, analysis: AnalysisResponse | null): Promise<void> {
  const result = await chrome.storage.local.get(`${SESSION_PREFIX}:analysis`);
  const analyses = (result[`${SESSION_PREFIX}:analysis`] ?? {}) as Record<string, AnalysisResponse>;
  analyses[formId] = analysis ?? { analysis: { snapshotId: formId, needsHumanReview: true, suggestions: [] } };
  await chrome.storage.local.set({ [`${SESSION_PREFIX}:analysis`]: analyses });
}

async function analyzeSnapshot(snapshot: FormSnapshot): Promise<AnalysisResponse | null> {
  try {
    const response = await fetch(`${LOCAL_API_URL}/v1/forms/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
    if (!response.ok) return null;
    return (await response.json()) as AnalysisResponse;
  } catch {
    return null;
  }
}

function openProfileTab(): void {
  const popupUrl = chrome.runtime.getURL(POPUP_HTML);
  void chrome.tabs.query({ url: popupUrl }, (existing) => {
    const tab = existing[0];
    if (tab && tab.id != null) {
      void chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        void chrome.windows.update(tab.windowId, { focused: true });
      }
    } else {
      void chrome.tabs.create({ url: popupUrl });
    }
  });
}

chrome.action.onClicked.addListener(openProfileTab);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ── Form snapshot analysis ─────────────────────────────────────────────────
  if (message?.type === 'FORM_SNAPSHOT') {
    void (async () => {
      const snapshot = message.snapshot as FormSnapshot;
      await storeSnapshot(snapshot);
      const analysis = await analyzeSnapshot(snapshot);
      await storeAnalysis(snapshot.formId, analysis);
      sendResponse({ ok: true, analysis });
    })();
    return true;
  }

  // ── Fetch current profile (popup can't fetch localhost directly) ───────────
  if (message?.type === 'GET_CURRENT_PROFILE') {
    void (async () => {
      try {
        const response = await fetch(`${LOCAL_API_URL}/v1/profile/current`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) { sendResponse({ ok: false, profile: null }); return; }
        const json = (await response.json()) as { profile: unknown };
        sendResponse({ ok: true, profile: json.profile });
      } catch {
        sendResponse({ ok: false, profile: null });
      }
    })();
    return true;
  }

  // ── Ingest documents (popup can't fetch localhost directly) ───────────────
  if (message?.type === 'INGEST_DOCUMENTS') {
    void (async () => {
      try {
        const { profileId, fullName, documents, answerStyle } = message as {
          profileId: string;
          fullName?: string;
          documents: unknown[];
          answerStyle: unknown;
        };
        const response = await fetch(`${LOCAL_API_URL}/v1/profile/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profileId, fullName, documents, answerStyle }),
          // No timeout — Ollama can take 60–120 s for large documents.
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          sendResponse({ ok: false, error: `API error ${response.status}: ${text || response.statusText}` });
          return;
        }
        const json = await response.json();
        sendResponse({ ok: true, data: json });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  // ── Health check ───────────────────────────────────────────────────────────
  if (message?.type === 'GET_HEALTH') {
    void (async () => {
      try {
        const response = await fetch(`${LOCAL_API_URL}/health`, {
          signal: AbortSignal.timeout(3000)
        });
        if (!response.ok) { sendResponse({ ok: false }); return; }
        const json = await response.json();
        sendResponse({ ok: true, ...json });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === 'OPEN_PROFILE_TAB') {
    openProfileTab();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'GET_LAST_SNAPSHOTS') {
    void (async () => {
      const snapshots = await getStoredSnapshots();
      sendResponse({ ok: true, snapshots });
    })();
    return true;
  }

  if (message?.type === 'GET_MODELS') {
    void (async () => {
      try {
        const response = await fetch(`${LOCAL_API_URL}/v1/models`, {
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) { sendResponse({ ok: false, models: [] }); return; }
        const json = (await response.json()) as { models: string[] };
        sendResponse({ ok: true, models: json.models });
      } catch {
        sendResponse({ ok: false, models: [] });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_SETTINGS') {
    void (async () => {
      const result = await chrome.storage.local.get('lsc-ai-settings');
      sendResponse({ ok: true, settings: result['lsc-ai-settings'] ?? {} });
    })();
    return true;
  }

  if (message?.type === 'SAVE_SETTINGS') {
    void (async () => {
      await chrome.storage.local.set({ 'lsc-ai-settings': message.settings });
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
