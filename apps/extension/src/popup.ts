import { compactText, type ApplicantProfile } from '@lsc-ai/shared';

type DocumentKind = 'resume' | 'cover-letter' | 'certificate' | 'portfolio' | 'job-description' | 'application-history' | 'other';

interface PopupDocument {
  documentId: string;
  kind: DocumentKind;
  title: string;
  text: string;
  mimeType?: string;
  base64?: string;
}

// All API calls go through the background service worker because Chrome blocks
// direct fetch from extension tab pages (chrome-extension:// origin) to http://
// localhost, even when host_permissions covers the URL.

function sendMessage<T>(message: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Background did not respond within ${timeoutMs / 1000}s`)),
      timeoutMs
    );

    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message ?? 'Extension messaging error'));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

interface AISettings {
  provider: 'ollama' | 'openai' | 'anthropic';
  model: string;
  apiKey: string;
}

async function apiGetProfile(): Promise<ApplicantProfile | null> {
  try {
    const res = await sendMessage<{ ok: boolean; profile?: unknown }>({ type: 'GET_CURRENT_PROFILE' });
    return res.ok && res.profile ? (res.profile as ApplicantProfile) : null;
  } catch {
    return null;
  }
}

async function apiGetSettings(): Promise<AISettings> {
  try {
    const res = await sendMessage<{ ok: boolean; settings?: Partial<AISettings> }>({ type: 'GET_SETTINGS' });
    return { provider: 'ollama', model: '', apiKey: '', ...(res.ok ? res.settings : {}) };
  } catch {
    return { provider: 'ollama', model: '', apiKey: '' };
  }
}

async function apiSaveSettings(settings: AISettings): Promise<void> {
  await sendMessage<{ ok: boolean }>({ type: 'SAVE_SETTINGS', settings });
}

async function apiGetModels(): Promise<string[]> {
  try {
    const res = await sendMessage<{ ok: boolean; models?: string[] }>({ type: 'GET_MODELS' }, 5000);
    return res.ok && res.models ? res.models : [];
  } catch {
    return [];
  }
}

async function apiIngest(
  documents: PopupDocument[],
  fullName?: string
): Promise<{ profile: ApplicantProfile }> {
  const res = await sendMessage<{ ok: boolean; data?: { profile: ApplicantProfile }; error?: string }>({
    type: 'INGEST_DOCUMENTS',
    profileId: 'local-user',
    fullName,
    documents,
    answerStyle: { tone: 'balanced' }
  });

  if (!res.ok) throw new Error(res.error ?? 'Ingest failed');
  if (!res.data) throw new Error('No data returned from API');
  return res.data;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(text: string, type: 'info' | 'error' | 'success' = 'info'): void {
  const node = el('status');
  if (!node) return;
  node.textContent = text;
  node.dataset['type'] = type;
  console.log(`[LSC AI] status(${type}):`, text);
}

function setButtonLoading(loading: boolean): void {
  const btn = el<HTMLButtonElement>('ingest-button');
  if (!btn) return;
  btn.disabled = loading;
  btn.dataset['loading'] = String(loading);
  btn.textContent = loading ? 'Processing…' : 'Ingest documents';
}

// ── File handling ─────────────────────────────────────────────────────────────

function documentKindFromTitle(title: string, text: string): DocumentKind {
  const combined = `${title} ${text}`.toLowerCase();
  if (combined.includes('resume') || combined.includes('cv')) return 'resume';
  if (combined.includes('cover letter') || combined.includes('motivation')) return 'cover-letter';
  if (combined.includes('certificate') || combined.includes('certification')) return 'certificate';
  if (combined.includes('portfolio') || combined.includes('project')) return 'portfolio';
  if (combined.includes('job description') || combined.includes('role overview')) return 'job-description';
  return 'other';
}

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read: ${file.name}`));
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

async function prepareDocuments(files: FileList | null): Promise<PopupDocument[]> {
  if (!files || files.length === 0) return [];
  const docs: PopupDocument[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    setStatus(`Reading file ${i + 1} of ${files.length}: ${file.name}…`);
    console.log(`[LSC AI] reading file ${i + 1}/${files.length}:`, file.name, file.type, file.size);

    const lower = file.name.toLowerCase();
    const isBinary =
      file.type.includes('pdf') ||
      file.type.includes('word') ||
      lower.endsWith('.pdf') ||
      lower.endsWith('.docx') ||
      lower.endsWith('.doc');

    if (isBinary) {
      const base64 = await readFileAsBase64(file);
      const mime = file.type || (lower.endsWith('.pdf')
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      docs.push({
        documentId: `${file.name}-${file.size}-${file.lastModified}`,
        kind: documentKindFromTitle(file.name, file.name),
        title: file.name,
        text: '',
        mimeType: mime,
        base64
      });
    } else {
      const text = await file.text();
      docs.push({
        documentId: `${file.name}-${file.size}-${file.lastModified}`,
        kind: documentKindFromTitle(file.name, text),
        title: file.name,
        text: compactText(text),
        mimeType: file.type || undefined
      });
    }
  }

  console.log(`[LSC AI] prepared ${docs.length} document(s)`);
  return docs;
}

// ── Profile render ────────────────────────────────────────────────────────────

function renderProfile(profile: ApplicantProfile | null | undefined): void {
  const node = el('profile');
  if (!node) return;

  if (!profile?.profileId || profile.profileId === 'anonymous') {
    node.textContent = 'No profile yet — select documents and click Ingest.';
    return;
  }

  const skills = Array.isArray(profile.skills) ? profile.skills.slice(0, 10) : [];
  const highlights = Array.isArray(profile.experienceHighlights) ? profile.experienceHighlights.slice(0, 5) : [];
  const docs = Array.isArray(profile.sourceDocuments)
    ? profile.sourceDocuments.map((d) => ({ kind: d.kind, title: d.title }))
    : [];

  node.textContent = JSON.stringify(
    { profileId: profile.profileId, fullName: profile.fullName, email: profile.email, phone: profile.phone, location: profile.location, skills, highlights, docs },
    null,
    2
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[LSC AI] popup main() starting');

  const fileInput      = el<HTMLInputElement>('document-input');
  const fileListNode   = el<HTMLElement>('file-list');
  const nameInput      = el<HTMLInputElement>('full-name-input');
  const ingestBtn      = el<HTMLButtonElement>('ingest-button');
  const refreshBtn     = el<HTMLButtonElement>('refresh-button');
  const providerSel    = el<HTMLSelectElement>('provider-select');
  const modelInput     = el<HTMLInputElement>('model-input');
  const modelDatalist  = el<HTMLDataListElement>('model-datalist');
  const apiKeyInput    = el<HTMLInputElement>('api-key-input');
  const apiKeyRow      = el<HTMLElement>('api-key-row');
  const saveSettingsBtn = el<HTMLButtonElement>('save-settings-button');
  const settingsStatus = el<HTMLElement>('settings-status');

  if (!fileInput || !fileListNode || !nameInput || !ingestBtn || !refreshBtn) {
    setStatus('UI error — missing DOM elements. Try reloading the page.', 'error');
    return;
  }

  // ── Settings panel helpers ────────────────────────────────────────────────

  const updateApiKeyVisibility = (): void => {
    if (apiKeyRow && providerSel) {
      apiKeyRow.style.display = providerSel.value === 'ollama' ? 'none' : '';
    }
  };

  const populateModelDatalist = async (): Promise<void> => {
    if (!modelDatalist) return;
    const models = await apiGetModels();
    modelDatalist.replaceChildren();
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      modelDatalist.appendChild(opt);
    });
  };

  if (providerSel) {
    providerSel.addEventListener('change', () => {
      updateApiKeyVisibility();
      if (providerSel.value === 'ollama') void populateModelDatalist();
    });
  }

  if (saveSettingsBtn && providerSel && modelInput && apiKeyInput && settingsStatus) {
    saveSettingsBtn.addEventListener('click', async () => {
      const settings: AISettings = {
        provider: providerSel.value as AISettings['provider'],
        model: modelInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
      };
      saveSettingsBtn.disabled = true;
      settingsStatus.style.display = 'flex';
      settingsStatus.dataset['type'] = 'info';
      settingsStatus.textContent = 'Saving…';
      try {
        await apiSaveSettings(settings);
        settingsStatus.dataset['type'] = 'success';
        settingsStatus.textContent = '✓ Settings saved.';
      } catch (err) {
        settingsStatus.dataset['type'] = 'error';
        settingsStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        saveSettingsBtn.disabled = false;
      }
    });
  }

  // ── Attach ALL listeners synchronously — never await before this ──────────

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files || files.length === 0) { fileListNode.textContent = ''; return; }
    fileListNode.textContent = Array.from(files)
      .map((f) => `• ${f.name} (${Math.round(f.size / 1024)} KB)`)
      .join('\n');
  });

  refreshBtn.addEventListener('click', async () => {
    setStatus('Refreshing…');
    const profile = await apiGetProfile();
    renderProfile(profile);
    setStatus(
      profile ? 'Profile refreshed.' : 'Cannot reach API — make sure pnpm dev:api is running.',
      profile ? 'success' : 'error'
    );
  });

  ingestBtn.addEventListener('click', async () => {
    console.log('[LSC AI] Ingest button clicked');
    setButtonLoading(true);
    setStatus('Step 1 of 3 — Reading files from disk…');

    try {
      const docs = await prepareDocuments(fileInput.files);

      if (docs.length === 0) {
        setStatus('Please select at least one document first.', 'error');
        return;
      }

      setStatus(`Step 2 of 3 — Sending ${docs.length} document(s) to API… (AI processing may take up to 60 s)`);
      console.log('[LSC AI] sending INGEST_DOCUMENTS for', docs.length, 'doc(s)');

      const fullName = compactText(nameInput.value) || undefined;
      const result = await apiIngest(docs, fullName);

      console.log('[LSC AI] ingest complete, profile:', result.profile?.profileId);
      setStatus('Step 3 of 3 — Rendering profile…');
      renderProfile(result.profile);
      setStatus(`Done! Profile built from ${docs.length} document(s).`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Error: ${msg}`, 'error');
      console.error('[LSC AI] ingest error:', err);
    } finally {
      setButtonLoading(false);
    }
  });

  // ── Non-blocking startup — must come AFTER listeners ─────────────────────
  setStatus('Connecting to API…');
  console.log('[LSC AI] checking API via background...');

  // Load AI settings and populate the form
  void apiGetSettings().then((settings) => {
    if (providerSel) providerSel.value = settings.provider;
    if (modelInput) modelInput.value = settings.model;
    if (apiKeyInput) apiKeyInput.value = settings.apiKey;
    updateApiKeyVisibility();
    if (settings.provider === 'ollama') void populateModelDatalist();
  });

  apiGetProfile()
    .then((profile) => {
      console.log('[LSC AI] profile loaded:', profile?.profileId ?? 'null');
      renderProfile(profile);
      setStatus(
        profile !== null
          ? 'API connected. Select documents then click Ingest.'
          : 'API offline — run: pnpm dev:api',
        profile !== null ? 'info' : 'error'
      );
    })
    .catch((err: unknown) => {
      console.error('[LSC AI] profile load error:', err);
      setStatus(`Connection error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[LSC AI] Fatal popup error:', msg, err);
  const pre = document.getElementById('profile');
  if (pre) pre.textContent = `Fatal error:\n${msg}\n\nOpen DevTools (F12) → Console for details.`;
  const status = document.getElementById('status');
  if (status) { status.textContent = 'Fatal error — see profile box.'; (status as HTMLElement).dataset['type'] = 'error'; }
});
