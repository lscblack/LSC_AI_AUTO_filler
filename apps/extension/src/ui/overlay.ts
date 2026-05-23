import type { ApplicantProfile, FormSnapshot } from '@lsc-ai/shared';
import type { AnalysisResponse } from '../background.js';
import { fillDeterministicField, resolveInteractiveFieldElement, setNativeValue } from '../dom/fill.js';

// ── types ─────────────────────────────────────────────────────────────────────

export interface OverlayState {
  snapshot: FormSnapshot;
  analysis: AnalysisResponse['analysis'] | null;
  profile: ApplicantProfile | null;
}

interface DraftRow {
  fieldId: string;
  label: string;
  value: string;
  loading: boolean;
  strategy: 'deterministic' | 'contextual';
}

interface OverlaySettings {
  provider: 'ollama' | 'openai' | 'anthropic';
  model: string;
  apiKey: string;
}

interface JobContext {
  company: string;
  title: string;
  description: string;
}

// ── constants ─────────────────────────────────────────────────────────────────

const OVERLAY_ID = 'lsc-ai-auto-filler-overlay';
const API = 'http://127.0.0.1:4317';
const AUTO_APPLY_S = 20;

// ── module state ──────────────────────────────────────────────────────────────

let activeState: OverlayState | null = null;
let inReview = false;
let isMinimized = false;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let overlaySettings: OverlaySettings = { provider: 'ollama', model: '', apiKey: '' };
let rootRef: HTMLDivElement | null = null;
let contentAreaRef: HTMLDivElement | null = null;
let bodyWrapRef: HTMLDivElement | null = null;
let settingsPanelRef: HTMLDivElement | null = null;
let settingsPanelVisible = false;
let dragState: { startX: number; startY: number; startLeft: number; startTop: number } | null = null;

// User-editable job context — overrides auto-detected values when set
let jobContextOverride: JobContext | null = null;

// Load settings from chrome.storage on module init
void (async () => {
  try {
    const r = await new Promise<{ ok: boolean; settings?: Partial<OverlaySettings> }>((res) => {
      const timer = setTimeout(() => res({ ok: false }), 3000);
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) res({ ok: false });
        else res(resp as { ok: boolean; settings?: Partial<OverlaySettings> });
      });
    });
    if (r.ok && r.settings) overlaySettings = { ...overlaySettings, ...r.settings };
  } catch { /* ignore */ }
})();

// Global drag move/up (attached once per document)
document.addEventListener('mousemove', (e) => {
  if (!dragState || !rootRef) return;
  const newLeft = Math.max(0, Math.min(window.innerWidth - 40, dragState.startLeft + (e.clientX - dragState.startX)));
  const newTop = Math.max(0, Math.min(window.innerHeight - 40, dragState.startTop + (e.clientY - dragState.startY)));
  rootRef.style.left = `${newLeft}px`;
  rootRef.style.top = `${newTop}px`;
  rootRef.style.right = 'auto';
});
document.addEventListener('mouseup', () => { dragState = null; });

// ── style helpers ─────────────────────────────────────────────────────────────

function d(css: Partial<CSSStyleDeclaration> = {}): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, css);
  return el;
}

const BTN: Partial<CSSStyleDeclaration> = {
  border: '0',
  borderRadius: '10px',
  padding: '9px 14px',
  fontWeight: '600',
  fontSize: '13px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  lineHeight: '1',
};

function mkBtn(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  Object.assign(b.style, BTN, {
    background: primary ? '#1f6feb' : '#eef2ff',
    color: primary ? '#fff' : '#1e40af',
  });
  return b;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── settings panel ────────────────────────────────────────────────────────────

function buildSettingsPanel(): HTMLDivElement {
  const panel = d({
    padding: '10px 14px 12px',
    borderBottom: '1px solid rgba(17,24,39,0.08)',
    background: '#f9fafb',
    fontSize: '12px',
  });

  const heading = d({ fontWeight: '700', fontSize: '12px', color: '#374151', marginBottom: '10px' });
  heading.textContent = 'AI Provider Settings';

  // Provider
  const provLabel = d({ fontSize: '11px', color: '#6b7280', fontWeight: '600', marginBottom: '4px' });
  provLabel.textContent = 'PROVIDER';
  const provSel = document.createElement('select');
  Object.assign(provSel.style, { width: '100%', border: '1px solid rgba(17,24,39,0.15)', borderRadius: '7px', padding: '6px 8px', fontSize: '12px', fontFamily: 'inherit', background: 'white', color: '#111827', cursor: 'pointer', marginBottom: '8px' });
  (['ollama', 'openai', 'anthropic'] as const).forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = ['Ollama (local)', 'OpenAI', 'Anthropic'][i] ?? v;
    provSel.appendChild(opt);
  });
  provSel.value = overlaySettings.provider;

  // Model
  const mdlLabel = d({ fontSize: '11px', color: '#6b7280', fontWeight: '600', marginBottom: '4px' });
  mdlLabel.textContent = 'MODEL';
  const mdlList = document.createElement('datalist');
  mdlList.id = 'lsc-ai-model-datalist';
  const mdlInput = document.createElement('input');
  mdlInput.type = 'text';
  mdlInput.setAttribute('list', 'lsc-ai-model-datalist');
  mdlInput.placeholder = 'e.g. llama3.1, gpt-4o-mini';
  mdlInput.value = overlaySettings.model;
  Object.assign(mdlInput.style, { width: '100%', border: '1px solid rgba(17,24,39,0.15)', borderRadius: '7px', padding: '6px 8px', fontSize: '12px', fontFamily: 'inherit', background: 'white', color: '#111827', outline: 'none', boxSizing: 'border-box', marginBottom: '8px' });

  // API key (hidden for Ollama)
  const keyWrap = d({ marginBottom: '10px' });
  const keyLabel = d({ fontSize: '11px', color: '#6b7280', fontWeight: '600', marginBottom: '4px' });
  keyLabel.textContent = 'API KEY';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'sk-…';
  keyInput.value = overlaySettings.apiKey;
  Object.assign(keyInput.style, { width: '100%', border: '1px solid rgba(17,24,39,0.15)', borderRadius: '7px', padding: '6px 8px', fontSize: '12px', fontFamily: 'inherit', background: 'white', color: '#111827', outline: 'none', boxSizing: 'border-box' });
  keyWrap.append(keyLabel, keyInput);

  const refreshKeyVisibility = (): void => {
    keyWrap.style.display = provSel.value === 'ollama' ? 'none' : '';
  };
  refreshKeyVisibility();

  provSel.addEventListener('change', () => {
    refreshKeyVisibility();
    if (provSel.value === 'ollama') void refreshModelList(mdlList);
  });

  // Fetch Ollama models if on Ollama
  if (overlaySettings.provider === 'ollama') void refreshModelList(mdlList);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  Object.assign(saveBtn.style, { ...BTN, background: '#1f6feb', color: 'white', fontSize: '12px', padding: '7px 14px', display: 'inline-block' });

  const saveStatus = d({ display: 'inline-block', marginLeft: '10px', fontSize: '11px', color: '#6b7280', verticalAlign: 'middle' });

  const btnRow = d({ display: 'flex', alignItems: 'center' });
  btnRow.append(saveBtn, saveStatus);

  saveBtn.addEventListener('click', () => {
    overlaySettings = {
      provider: provSel.value as OverlaySettings['provider'],
      model: mdlInput.value.trim(),
      apiKey: keyInput.value.trim(),
    };
    void (async () => {
      try {
        await new Promise<void>((res) => {
          chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: overlaySettings }, () => res());
        });
        saveStatus.textContent = '✓ Saved';
        saveStatus.style.color = '#16a34a';
        setTimeout(() => {
          if (settingsPanelRef) {
            settingsPanelRef.style.display = 'none';
            settingsPanelVisible = false;
          }
        }, 700);
      } catch {
        saveStatus.textContent = 'Error';
        saveStatus.style.color = '#dc2626';
      }
    })();
  });

  panel.append(heading, provLabel, provSel, mdlLabel, mdlInput, mdlList, keyWrap, btnRow);
  return panel;
}

async function refreshModelList(datalist: HTMLDataListElement): Promise<void> {
  try {
    const r = await new Promise<{ ok: boolean; models?: string[] }>((res) => {
      const timer = setTimeout(() => res({ ok: false }), 5000);
      chrome.runtime.sendMessage({ type: 'GET_MODELS' }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) res({ ok: false });
        else res(resp as { ok: boolean; models?: string[] });
      });
    });
    if (r.ok && r.models?.length) {
      datalist.replaceChildren();
      r.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        datalist.appendChild(opt);
      });
    }
  } catch { /* ignore */ }
}

// ── root structure (persistent — never replaced) ──────────────────────────────

function ensureRoot(): void {
  if (rootRef?.isConnected) return;

  const root = document.createElement('div') as HTMLDivElement;
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    width: '360px',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: '13px',
    color: '#111827',
    background: 'rgba(255,253,248,0.98)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(17,24,39,0.12)',
    borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(17,24,39,0.2)',
    overflow: 'hidden',
  });

  // Title bar — drag handle
  const titleBar = d({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '11px 12px 10px',
    cursor: 'move',
    borderBottom: '1px solid rgba(17,24,39,0.07)',
    userSelect: 'none',
    flexShrink: '0',
  });

  titleBar.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = root.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
    e.preventDefault();
  });

  const titleText = d({ fontWeight: '700', fontSize: '13px', color: '#111827', flex: '1' });
  titleText.textContent = '⚡ Application Assist';

  const controls = d({ display: 'flex', gap: '2px', alignItems: 'center' });

  const mkIconBtn = (text: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    Object.assign(b.style, { border: '0', background: 'transparent', cursor: 'pointer', fontSize: '14px', padding: '3px 6px', borderRadius: '6px', color: '#6b7280', lineHeight: '1', fontFamily: 'inherit', fontWeight: '600' });
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(17,24,39,0.06)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    return b;
  };

  const settingsBtn = mkIconBtn('⚙', 'AI model settings');
  const minimizeBtn = mkIconBtn('−', 'Minimize');

  controls.append(settingsBtn, minimizeBtn);
  titleBar.append(titleText, controls);

  // Body (collapsible)
  const bodyWrap = d({ overflow: 'hidden' });

  // Settings panel (hidden by default)
  const settingsPanel = buildSettingsPanel();
  settingsPanel.style.display = 'none';
  bodyWrap.appendChild(settingsPanel);

  // Content area (replaced by showMain / showReview / applyAll)
  const contentArea = d({ padding: '12px 14px 14px' });
  bodyWrap.appendChild(contentArea);

  root.append(titleBar, bodyWrap);
  document.documentElement.appendChild(root);

  // Minimize / expand
  minimizeBtn.addEventListener('click', () => {
    isMinimized = !isMinimized;
    bodyWrap.style.display = isMinimized ? 'none' : '';
    titleBar.style.borderBottom = isMinimized ? '0' : '1px solid rgba(17,24,39,0.07)';
    minimizeBtn.textContent = isMinimized ? '+' : '−';
    minimizeBtn.title = isMinimized ? 'Expand' : 'Minimize';
  });

  // Settings toggle
  settingsBtn.addEventListener('click', () => {
    settingsPanelVisible = !settingsPanelVisible;
    settingsPanel.style.display = settingsPanelVisible ? 'block' : 'none';
  });

  rootRef = root;
  contentAreaRef = contentArea;
  bodyWrapRef = bodyWrap;
  settingsPanelRef = settingsPanel;
}

// ── file upload helpers ───────────────────────────────────────────────────────

function readBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error('Read failed'));
    r.onload = () => res((r.result as string).split(',')[1] ?? '');
    r.readAsDataURL(file);
  });
}

async function ingestFiles(files: FileList, state: OverlayState, statusEl: HTMLElement): Promise<void> {
  statusEl.textContent = `Reading ${files.length} file(s)…`;
  statusEl.style.color = '#1f6feb';

  try {
    const documents: Array<Record<string, unknown>> = [];
    for (const file of Array.from(files)) {
      statusEl.textContent = `Reading: ${file.name}`;
      const lower = file.name.toLowerCase();
      const binary = lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.doc') || file.type.includes('pdf') || file.type.includes('word');
      const kind = lower.includes('resume') || lower.includes('cv') ? 'resume'
        : lower.includes('cover') ? 'cover-letter'
        : lower.includes('cert') ? 'certificate' : 'other';
      if (binary) {
        const base64 = await readBase64(file);
        documents.push({
          documentId: `${file.name}-${file.size}`,
          kind, title: file.name, text: '',
          mimeType: file.type || (lower.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
          base64,
        });
      } else {
        const text = await file.text();
        documents.push({ documentId: `${file.name}-${file.size}`, kind, title: file.name, text: text.slice(0, 50000), mimeType: file.type || 'text/plain' });
      }
    }

    statusEl.textContent = `Sending ${documents.length} doc(s) to AI (may take ~60 s)…`;

    const result = await new Promise<{ ok: boolean; data?: { profile: ApplicantProfile }; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'Timeout — background did not respond' }), 120000);
      chrome.runtime.sendMessage({ type: 'INGEST_DOCUMENTS', profileId: 'local-user', documents, answerStyle: { tone: 'balanced' } }, (r) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r as { ok: boolean; data?: { profile: ApplicantProfile }; error?: string });
      });
    });

    if (!result.ok || !result.data?.profile) {
      statusEl.textContent = `Upload failed: ${result.error ?? 'unknown error'}`;
      statusEl.style.color = '#dc2626';
      return;
    }

    state.profile = result.data.profile;
    const count = Array.isArray(state.profile.sourceDocuments) ? state.profile.sourceDocuments.length : 0;
    statusEl.textContent = `Profile updated — ${count} doc(s) loaded.`;
    statusEl.style.color = '#16a34a';

    if (!inReview) showMain(state);
  } catch (err) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    statusEl.style.color = '#dc2626';
  }
}

// ── API call for contextual answers ──────────────────────────────────────────

async function draftAnswer(
  question: string,
  profile: ApplicantProfile,
  context: FormSnapshot['context'],
  jobCtx?: JobContext
): Promise<string | null> {
  try {
    // Merge auto-detected context with user overrides — user input wins
    const company = jobCtx?.company || context.companyHint;
    const title = jobCtx?.title || context.jobTitleHint;
    const description = jobCtx?.description || context.jobDescription || context.visibleText;

    const body: Record<string, unknown> = {
      profile,
      question,
      companyName: company,
      jobTitle: title,
      jobDescription: description,
    };
    if (overlaySettings.provider !== 'ollama') {
      body.provider = overlaySettings.provider;
      if (overlaySettings.model) body.model = overlaySettings.model;
      if (overlaySettings.apiKey) body.apiKey = overlaySettings.apiKey;
    } else if (overlaySettings.model) {
      body.model = overlaySettings.model;
    }

    const res = await fetch(`${API}/v1/answers/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { draft?: { answer?: string } };
    return json.draft?.answer?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── build draft rows ──────────────────────────────────────────────────────────

function buildRows(state: OverlayState): DraftRow[] {
  const rows: DraftRow[] = [];
  const skipKinds = new Set(['file', 'password', 'unknown']);

  for (const field of state.snapshot.fields) {
    if (skipKinds.has(field.kind)) continue;
    const label = (field.label || field.placeholder || field.name || field.id).trim();
    if (!label) continue;

    if (state.profile) {
      const value = fillDeterministicField(field, state.profile);
      if (value) {
        rows.push({ fieldId: field.id, label, value, loading: false, strategy: 'deterministic' });
        continue;
      }
    }

    if (
      field.kind === 'textarea' ||
      field.kind === 'rich-text' ||
      /\?|why|describe|tell|explain|experience|motivation|interest|cover|reason|background|strength|goal/i.test(label)
    ) {
      rows.push({ fieldId: field.id, label, value: '', loading: true, strategy: 'contextual' });
      continue;
    }

    if (field.kind === 'text' || field.kind === 'email' || field.kind === 'phone' || field.kind === 'number') {
      rows.push({ fieldId: field.id, label, value: '', loading: true, strategy: 'contextual' });
    }
  }

  return rows;
}

// ── main panel ────────────────────────────────────────────────────────────────

function showMain(state: OverlayState): void {
  inReview = false;
  clearCountdown();
  if (!contentAreaRef) return;

  const docCount = Array.isArray(state.profile?.sourceDocuments) && (state.profile!.sourceDocuments.length ?? 0) > 0
    ? `${state.profile!.sourceDocuments.length} doc(s) loaded`
    : 'no docs — upload below';

  const content = d();

  const subtitle = d({ fontSize: '12px', color: '#6b7280' });
  subtitle.dataset['subtitle'] = '1';
  subtitle.textContent = `${state.snapshot.fields.length} fields · ${state.snapshot.siteHost} · ${docCount}`;

  // Upload area
  const uploadWrap = d({ marginTop: '10px' });
  const dropZone = d({
    border: '1.5px dashed rgba(17,24,39,0.18)',
    borderRadius: '10px',
    padding: '11px',
    textAlign: 'center',
    cursor: 'pointer',
    color: '#6b7280',
    fontSize: '12px',
    background: '#fafaf8',
  });

  const dropLabel = document.createElement('span');
  dropLabel.textContent = '📄 Drop resume / CV  ·  or click to browse';
  dropZone.appendChild(dropLabel);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.pdf,.docx,.doc,.txt,.md';
  fileInput.style.display = 'none';
  dropZone.appendChild(fileInput);

  const uploadStatus = d({ fontSize: '11px', marginTop: '4px', minHeight: '14px', color: '#6b7280' });

  dropZone.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#1f6feb'; dropZone.style.background = '#eff6ff'; });
  dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'rgba(17,24,39,0.18)'; dropZone.style.background = '#fafaf8'; });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'rgba(17,24,39,0.18)'; dropZone.style.background = '#fafaf8';
    if (e.dataTransfer?.files.length) await ingestFiles(e.dataTransfer.files, state, uploadStatus);
  });
  fileInput.addEventListener('change', async () => {
    if (fileInput.files?.length) { await ingestFiles(fileInput.files, state, uploadStatus); fileInput.value = ''; }
  });

  uploadWrap.append(dropZone, uploadStatus);

  // ── Job Info panel ──
  const ctx = state.snapshot.context;
  const autoCompany = ctx.companyHint ?? '';
  const autoTitle = ctx.jobTitleHint ?? '';
  const autoDesc = ctx.jobDescription ?? ctx.visibleText ?? '';

  // Initialise from override if set, otherwise from auto-detected
  const currentJob: JobContext = jobContextOverride ?? {
    company: autoCompany,
    title: autoTitle,
    description: autoDesc.slice(0, 3000),
  };

  const jobWrap = d({ marginTop: '10px', border: '1px solid rgba(17,24,39,0.1)', borderRadius: '10px', overflow: 'hidden' });

  // Toggle header
  const jobHeader = d({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 10px', cursor: 'pointer', background: '#f9fafb',
    fontSize: '12px', fontWeight: '600', color: '#374151',
  });
  let jobPanelOpen = !!(currentJob.company || currentJob.title || jobContextOverride);

  const jobHeaderLabel = document.createElement('span');
  const updateJobHeaderLabel = (): void => {
    const tag = currentJob.company && currentJob.title
      ? `${currentJob.title} @ ${currentJob.company}`
      : currentJob.title || currentJob.company || 'No job context detected';
    jobHeaderLabel.textContent = `📋 Job Context · ${tag}`;
  };
  updateJobHeaderLabel();

  const jobToggleArrow = document.createElement('span');
  jobToggleArrow.style.cssText = 'font-size:10px;color:#9ca3af;transition:transform 0.15s';
  jobToggleArrow.textContent = '▼';

  jobHeader.append(jobHeaderLabel, jobToggleArrow);

  // Collapsible body
  const jobBody = d({ padding: '10px', background: 'white', display: jobPanelOpen ? 'block' : 'none' });

  const mkField = (label: string, placeholder: string, value: string, multiline = false): { wrap: HTMLDivElement; input: HTMLInputElement | HTMLTextAreaElement } => {
    const wrap = d({ marginBottom: '8px' });
    const lbl = d({ fontSize: '10px', fontWeight: '700', color: '#6b7280', marginBottom: '3px', letterSpacing: '0.05em' });
    lbl.textContent = label;
    const inputStyle: Partial<CSSStyleDeclaration> = { width: '100%', border: '1px solid rgba(17,24,39,0.15)', borderRadius: '7px', padding: '6px 8px', fontSize: '12px', fontFamily: 'inherit', background: 'white', outline: 'none', color: '#111827', boxSizing: 'border-box' };
    let input: HTMLInputElement | HTMLTextAreaElement;
    if (multiline) {
      const ta = document.createElement('textarea');
      ta.rows = 4;
      ta.value = value;
      ta.placeholder = placeholder;
      Object.assign(ta.style, inputStyle, { resize: 'vertical' });
      input = ta;
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = value;
      inp.placeholder = placeholder;
      Object.assign(inp.style, inputStyle);
      input = inp;
    }
    wrap.append(lbl, input);
    return { wrap, input };
  };

  const { wrap: companyWrap, input: companyInput } = mkField('COMPANY', 'e.g. Acme Corp', currentJob.company);
  const { wrap: titleWrap, input: titleInput } = mkField('JOB TITLE', 'e.g. Software Engineer', currentJob.title);
  const { wrap: descWrap, input: descInput } = mkField('JOB DESCRIPTION', 'Paste the job posting here…', currentJob.description, true);

  const autoTag = d({ fontSize: '10px', color: '#9ca3af', marginBottom: '8px' });
  const hasAuto = autoCompany || autoTitle || (autoDesc.length > 20);
  autoTag.textContent = hasAuto ? '✓ Auto-detected from page — edit to override' : 'Nothing auto-detected · paste job details below';
  autoTag.style.color = hasAuto ? '#16a34a' : '#f59e0b';

  const saveJobBtn = document.createElement('button');
  saveJobBtn.textContent = 'Use this job context';
  Object.assign(saveJobBtn.style, { ...BTN, background: '#1f6feb', color: 'white', fontSize: '12px', padding: '7px 12px', display: 'block', width: '100%' });

  saveJobBtn.addEventListener('click', () => {
    jobContextOverride = {
      company: (companyInput as HTMLInputElement).value.trim(),
      title: (titleInput as HTMLInputElement).value.trim(),
      description: (descInput as HTMLTextAreaElement).value.trim(),
    };
    currentJob.company = jobContextOverride.company;
    currentJob.title = jobContextOverride.title;
    currentJob.description = jobContextOverride.description;
    updateJobHeaderLabel();
    // Collapse
    jobPanelOpen = false;
    jobBody.style.display = 'none';
    jobToggleArrow.style.transform = '';
    saveJobBtn.textContent = '✓ Saved — click Review to generate answers';
    saveJobBtn.style.background = '#16a34a';
    setTimeout(() => { saveJobBtn.textContent = 'Use this job context'; saveJobBtn.style.background = '#1f6feb'; }, 2000);
  });

  jobBody.append(autoTag, companyWrap, titleWrap, descWrap, saveJobBtn);
  jobWrap.append(jobHeader, jobBody);

  // Toggle on header click
  jobHeader.addEventListener('click', () => {
    jobPanelOpen = !jobPanelOpen;
    jobBody.style.display = jobPanelOpen ? 'block' : 'none';
    jobToggleArrow.style.transform = jobPanelOpen ? 'rotate(180deg)' : '';
  });

  // ── Actions ──
  const actions = d({ display: 'flex', gap: '8px', marginTop: '10px' });
  const reviewBtn = mkBtn('Review & Fill All Fields', true);
  reviewBtn.style.flex = '1';
  reviewBtn.addEventListener('click', () => void showReview(state));

  const hideBtn = mkBtn('Hide');
  hideBtn.addEventListener('click', () => { if (rootRef) rootRef.remove(); rootRef = null; });

  actions.append(reviewBtn, hideBtn);
  content.append(subtitle, uploadWrap, jobWrap, actions);
  contentAreaRef.replaceChildren(content);
}

// ── review panel ──────────────────────────────────────────────────────────────

async function showReview(state: OverlayState): Promise<void> {
  inReview = true;
  clearCountdown();
  if (!contentAreaRef) return;

  // Resolve job context — user override wins over auto-detected
  const ctx = state.snapshot.context;
  const activeJobCtx: JobContext = jobContextOverride ?? {
    company: ctx.companyHint ?? '',
    title: ctx.jobTitleHint ?? '',
    description: ctx.jobDescription ?? ctx.visibleText ?? '',
  };

  const rows = buildRows(state);

  if (rows.length === 0) {
    showMain(state);
    return;
  }

  // Make the content area flex so the list can scroll independently
  Object.assign(contentAreaRef.style, {
    padding: '0',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(80vh - 44px)',
  });

  const header = d({ padding: '10px 14px 6px', flexShrink: '0' });

  const headTitle = d({ fontWeight: '700', fontSize: '13px' });
  headTitle.textContent = 'Review & Fill';

  const subhdr = d({ fontSize: '11px', color: '#6b7280', marginTop: '2px' });
  const jobTag = activeJobCtx.title || activeJobCtx.company
    ? ` · ${[activeJobCtx.title, activeJobCtx.company].filter(Boolean).join(' @ ')}`
    : '';
  subhdr.textContent = `${rows.length} field(s) · edit any value before applying${jobTag}`;

  // Countdown bar
  const cdWrap = d({ padding: '0 14px 8px', flexShrink: '0' });
  const cdText = d({ fontSize: '11px', color: '#6b7280', marginBottom: '3px' });
  cdText.textContent = `Auto-applying in ${AUTO_APPLY_S}s — edit anything to pause`;
  const barTrack = d({ height: '4px', background: '#e5e7eb', borderRadius: '2px' });
  const barFill = d({ height: '100%', background: '#1f6feb', borderRadius: '2px', width: '100%', transition: 'width 1s linear' });
  barTrack.appendChild(barFill);
  cdWrap.append(cdText, barTrack);

  let paused = false;
  let secondsLeft = AUTO_APPLY_S;
  const pauseCountdown = (): void => {
    if (paused) return;
    paused = true;
    clearCountdown();
    barFill.style.width = '0%';
    cdText.textContent = 'Countdown paused — click Apply All when ready';
    cdText.style.color = '#374151';
  };

  // Scrollable field list
  const listWrap = d({ overflowY: 'auto', flex: '1', padding: '0 14px', paddingBottom: '4px' });
  listWrap.addEventListener('input', pauseCountdown);

  const editMap = new Map<string, HTMLInputElement | HTMLTextAreaElement>();

  for (const row of rows) {
    const field = state.snapshot.fields.find((f) => f.id === row.fieldId);

    const rowEl = d({ borderTop: '1px solid rgba(17,24,39,0.07)', paddingTop: '8px', paddingBottom: '4px' });

    // Label + badge
    const labelRow = d({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' });
    const labelEl = document.createElement('span');
    const badge = row.strategy === 'deterministic'
      ? `<span style="color:#16a34a;font-size:10px;font-weight:400"> · auto</span>`
      : `<span style="color:#1f6feb;font-size:10px;font-weight:400"> · AI</span>`;
    labelEl.innerHTML = `<span style="font-weight:600;font-size:12px;color:#374151">${escHtml(row.label)}</span>${badge}`;

    const isLong = field?.kind === 'textarea' || field?.kind === 'rich-text';
    let inputEl: HTMLInputElement | HTMLTextAreaElement;

    if (isLong) {
      const ta = document.createElement('textarea');
      ta.value = row.value;
      ta.rows = 3;
      Object.assign(ta.style, { width: '100%', border: '1px solid rgba(17,24,39,0.15)', borderRadius: '8px', padding: '7px 9px', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical', background: 'white', outline: 'none', color: '#111827', boxSizing: 'border-box' });
      inputEl = ta;
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = row.value;
      Object.assign(inp.style, { width: '100%', border: '1px solid rgba(17,24,39,0.15)', borderRadius: '8px', padding: '7px 9px', fontSize: '12px', fontFamily: 'inherit', background: 'white', outline: 'none', color: '#111827', boxSizing: 'border-box' });
      inputEl = inp;
    }

    if (row.loading) {
      inputEl.disabled = true;
      inputEl.placeholder = '⟳ AI generating…';
      inputEl.style.opacity = '0.55';
    }

    labelRow.appendChild(labelEl);

    // Regenerate button for AI fields
    if (row.strategy === 'contextual') {
      const regenBtn = document.createElement('button');
      regenBtn.textContent = '⟳';
      regenBtn.title = 'Regenerate answer';
      Object.assign(regenBtn.style, { border: '0', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: '#1f6feb', padding: '2px 4px', borderRadius: '5px', lineHeight: '1', fontFamily: 'inherit' });
      regenBtn.addEventListener('mouseenter', () => { regenBtn.style.background = '#eff6ff'; });
      regenBtn.addEventListener('mouseleave', () => { regenBtn.style.background = 'transparent'; });
      regenBtn.addEventListener('click', () => {
        if (!state.profile) return;
        pauseCountdown();
        regenBtn.style.opacity = '0.4';
        regenBtn.style.cursor = 'wait';
        inputEl.disabled = true;
        inputEl.style.opacity = '0.55';
        inputEl.value = '';
        inputEl.placeholder = '⟳ Regenerating…';
        const question = field?.label || field?.placeholder || row.label;
        void draftAnswer(question, state.profile!, state.snapshot.context, activeJobCtx).then((answer) => {
          inputEl.value = answer ?? `[No answer for "${row.label}"]`;
          inputEl.disabled = false;
          inputEl.style.opacity = '1';
          inputEl.placeholder = '';
          regenBtn.style.opacity = '1';
          regenBtn.style.cursor = 'pointer';
        });
      });
      labelRow.appendChild(regenBtn);
    }

    // Per-field Apply button
    const btnRow = d({ display: 'flex', gap: '6px', marginTop: '4px' });
    const applyOneBtn = document.createElement('button');
    applyOneBtn.textContent = 'Apply';
    Object.assign(applyOneBtn.style, { ...BTN, padding: '4px 10px', fontSize: '11px', background: '#f0f9ff', color: '#0369a1' });
    applyOneBtn.addEventListener('click', () => {
      if (!field || (applyOneBtn as HTMLButtonElement).disabled) return;
      const el = resolveInteractiveFieldElement(field, document);
      if (el && inputEl.value) {
        setNativeValue(el, inputEl.value);
        applyOneBtn.textContent = '✓ Applied';
        applyOneBtn.style.background = '#f0fdf4';
        applyOneBtn.style.color = '#16a34a';
        (applyOneBtn as HTMLButtonElement).disabled = true;
      }
    });
    btnRow.appendChild(applyOneBtn);

    rowEl.append(labelRow, inputEl, btnRow);
    listWrap.appendChild(rowEl);
    editMap.set(row.fieldId, inputEl);
  }

  // Action buttons
  const actionsWrap = d({ padding: '10px 14px 12px', display: 'flex', gap: '8px', flexShrink: '0', borderTop: '1px solid rgba(17,24,39,0.07)' });
  const applyAllBtn = mkBtn('Apply All', true);
  applyAllBtn.style.flex = '1';
  const cancelBtn = mkBtn('Back');

  const doApplyAll = (): void => {
    clearCountdown();
    const finalRows = rows.map((r) => ({ ...r, value: editMap.get(r.fieldId)?.value ?? r.value }));
    applyAll(finalRows, state);
  };

  applyAllBtn.addEventListener('click', doApplyAll);
  cancelBtn.addEventListener('click', () => {
    clearCountdown();
    inReview = false;
    // Reset content area style
    Object.assign(contentAreaRef!.style, { padding: '12px 14px 14px', display: '', flexDirection: '', maxHeight: '' });
    showMain(state);
  });

  actionsWrap.append(applyAllBtn, cancelBtn);

  header.append(headTitle, subhdr);
  contentAreaRef.replaceChildren(header, cdWrap, listWrap, actionsWrap);

  // Start countdown
  countdownTimer = setInterval(() => {
    if (paused) { clearCountdown(); return; }
    secondsLeft -= 1;
    barFill.style.width = `${(secondsLeft / AUTO_APPLY_S) * 100}%`;
    cdText.textContent = `Auto-applying in ${secondsLeft}s — edit anything to pause`;
    if (secondsLeft <= 0) { clearCountdown(); doApplyAll(); }
  }, 1000);

  // Fire contextual drafts in parallel
  if (state.profile) {
    const contextualRows = rows.filter((r) => r.strategy === 'contextual');
    void Promise.all(
      contextualRows.map(async (row) => {
        const field = state.snapshot.fields.find((f) => f.id === row.fieldId);
        const question = field?.label || field?.placeholder || row.label;
        const answer = await draftAnswer(question, state.profile!, state.snapshot.context, activeJobCtx);
        const el = editMap.get(row.fieldId);
        if (el) {
          el.value = answer ?? `[No answer — check profile for "${row.label}"]`;
          el.disabled = false;
          el.style.opacity = '1';
          el.placeholder = '';
        }
      })
    );
  } else {
    for (const row of rows.filter((r) => r.loading)) {
      const el = editMap.get(row.fieldId);
      if (el) { el.value = ''; el.placeholder = 'Upload docs first'; el.disabled = false; el.style.opacity = '0.7'; }
    }
  }
}

// ── apply all ─────────────────────────────────────────────────────────────────

function applyAll(rows: DraftRow[], state: OverlayState): void {
  let count = 0;
  for (const row of rows) {
    if (!row.value) continue;
    const field = state.snapshot.fields.find((f) => f.id === row.fieldId);
    if (!field) continue;
    const el = resolveInteractiveFieldElement(field, document);
    if (el) { setNativeValue(el, row.value); count++; }
  }

  inReview = false;

  // Reset content area style
  if (contentAreaRef) {
    Object.assign(contentAreaRef.style, { padding: '12px 14px 14px', display: '', flexDirection: '', maxHeight: '' });
  }

  if (!contentAreaRef) return;

  const content = d();

  const title = d({ fontWeight: '700', fontSize: '13px' });
  title.textContent = `Applied ${count} of ${rows.length} field(s)`;

  const note = d({ fontSize: '12px', color: '#16a34a', marginTop: '4px' });
  note.textContent = 'Review the form — edit anything before submitting.';

  const actions = d({ display: 'flex', gap: '8px', marginTop: '10px' });
  const reviewAgainBtn = mkBtn('Review again');
  const hideBtn = mkBtn('Hide');
  reviewAgainBtn.addEventListener('click', () => void showReview(state));
  hideBtn.addEventListener('click', () => { if (rootRef) rootRef.remove(); rootRef = null; });
  actions.append(reviewAgainBtn, hideBtn);

  content.append(title, note, actions);
  contentAreaRef.replaceChildren(content);
}

// ── countdown cleanup ─────────────────────────────────────────────────────────

function clearCountdown(): void {
  if (countdownTimer !== undefined) { clearInterval(countdownTimer); countdownTimer = undefined; }
}

// ── public entry point ────────────────────────────────────────────────────────

export function renderOverlay(state: OverlayState): void {
  activeState = state;
  if (inReview) return;

  ensureRoot();

  if (!contentAreaRef) return;

  // If content area already has children, just update the subtitle
  const sub = contentAreaRef.querySelector('[data-subtitle]') as HTMLElement | null;
  if (sub && contentAreaRef.children.length > 0) {
    const docCount = Array.isArray(state.profile?.sourceDocuments) && state.profile!.sourceDocuments.length > 0
      ? `${state.profile!.sourceDocuments.length} doc(s) loaded` : 'no docs — upload below';
    sub.textContent = `${state.snapshot.fields.length} fields · ${state.snapshot.siteHost} · ${docCount}`;
    return;
  }

  showMain(state);
}
