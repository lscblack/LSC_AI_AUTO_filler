import { FormSnapshotSchema, type ApplicantProfile, type FormSnapshot } from '@lsc-ai/shared';
import { scanForms } from './dom/scan.js';
import { renderOverlay } from './ui/overlay.js';

type AnalysisResponse = {
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
};

let lastFingerprint = '';
let lastUrl = window.location.href;
let debounceTimer: number | undefined;
let contextInvalidated = false;

const snapshotMap = new Map<string, FormSnapshot>();
const analysisMap = new Map<string, AnalysisResponse['analysis']>();

let cachedProfile: ApplicantProfile | null = null;
let profileCachedAt = 0;
const PROFILE_TTL_MS = 30_000;

// Returns false when the extension has been reloaded and this content script
// is now orphaned. All chrome.runtime calls throw in that state.
function runtimeAlive(): boolean {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

function fingerprint(snapshots: ReturnType<typeof scanForms>): string {
  return snapshots
    .map((s) => `${s.formId}:${s.fields.map((f) => `${f.id}:${f.label}:${f.kind}`).join('|')}`)
    .join(';;');
}

function pickBestSnapshot(): FormSnapshot | null {
  if (snapshotMap.size === 0) return null;
  let best: FormSnapshot | null = null;
  let bestScore = -1;
  for (const snapshot of snapshotMap.values()) {
    const analysis = analysisMap.get(snapshot.formId);
    const score = snapshot.fields.length + (analysis?.suggestions.length ?? 0) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = snapshot;
    }
  }
  return best;
}

function clearSessionIfUrlChanged(): void {
  const currentUrl = window.location.href;
  if (currentUrl === lastUrl) return;
  lastUrl = currentUrl;
  lastFingerprint = '';
  snapshotMap.clear();
  analysisMap.clear();
  cachedProfile = null;
  profileCachedAt = 0;
}

function postSnapshots(): void {
  // If the extension was reloaded, this content script is orphaned.
  // Stop the observer and bail out — the user needs to reload the page.
  if (!runtimeAlive()) {
    if (!contextInvalidated) {
      contextInvalidated = true;
      observer.disconnect();
      console.info('[LSC AI] Extension was reloaded — reload this page to reconnect.');
    }
    return;
  }

  clearSessionIfUrlChanged();

  let snapshots = [] as ReturnType<typeof scanForms>;
  try {
    snapshots = scanForms(document);
  } catch (err) {
    console.error('Error scanning forms:', err);
    return;
  }

  const currentFingerprint = fingerprint(snapshots);
  if (currentFingerprint === lastFingerprint) return;
  lastFingerprint = currentFingerprint;

  for (const snapshot of snapshots) {
    let parsed: FormSnapshot;
    try {
      parsed = FormSnapshotSchema.parse(snapshot) as FormSnapshot;
    } catch (err) {
      console.error('Form snapshot validation failed:', err);
      continue;
    }

    snapshotMap.set(parsed.formId, parsed);

    try {
      chrome.runtime.sendMessage(
        { type: 'FORM_SNAPSHOT', snapshot: parsed },
        (response?: { ok?: boolean; analysis?: AnalysisResponse | null }) => {
          if (chrome.runtime.lastError) {
            // Suppress "receiving end does not exist" noise on extension reload.
            return;
          }
          const analysis = response?.analysis?.analysis;
          if (analysis) {
            analysisMap.set(parsed.formId, analysis);
          }
          void refreshOverlay();
        }
      );
    } catch {
      // Runtime went away mid-call — stop trying.
      contextInvalidated = true;
      observer.disconnect();
    }
  }
}

async function fetchProfile(): Promise<ApplicantProfile | null> {
  const now = Date.now();
  if (cachedProfile && now - profileCachedAt < PROFILE_TTL_MS) return cachedProfile;
  try {
    const response = await fetch('http://127.0.0.1:4317/v1/profile/current');
    if (!response.ok) return null;
    const json = (await response.json()) as { profile?: ApplicantProfile };
    cachedProfile = json.profile ?? null;
    profileCachedAt = Date.now();
    return cachedProfile;
  } catch {
    return null;
  }
}

async function refreshOverlay(): Promise<void> {
  const snapshot = pickBestSnapshot();
  if (!snapshot) return;
  const profile = await fetchProfile();
  const analysis = analysisMap.get(snapshot.formId) ?? null;
  renderOverlay({ snapshot, analysis, profile });
}

const observer = new MutationObserver(() => {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(postSnapshots, 300);
});

postSnapshots();
void refreshOverlay();
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true
});

// Guard onMessage — chrome.runtime may already be dead if the extension was
// reloaded before this script first ran (e.g. injected into a pre-existing tab).
try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'FORM_ANALYSIS_RESULT') {
      const analysis = message.analysis as AnalysisResponse['analysis'];
      if (analysis?.snapshotId) {
        analysisMap.set(analysis.snapshotId, analysis);
      }
      void refreshOverlay();
    }
  });
} catch {
  contextInvalidated = true;
}
