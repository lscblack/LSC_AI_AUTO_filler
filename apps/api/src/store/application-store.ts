import { resolve } from 'node:path';
import { ApplicantProfileSchema, type ApplicantProfile } from '@lsc-ai/shared';
import { buildApplicantProfile, type DocumentInput, type ProfileBuildRequest } from '../engine/profile-builder.js';
import { normalizeDocumentText } from '../engine/document-extractor.js';
import { readJsonFile, writeJsonFile } from './json-store.js';

export interface PersistedApplicationStore {
  currentProfile: ApplicantProfile;
  documents: DocumentInput[];
  history: Array<Record<string, unknown>>;
}

const DATA_DIR = resolve(process.cwd(), 'data');
const STORE_FILE = resolve(DATA_DIR, 'application-store.json');

const DEFAULT_STORE: PersistedApplicationStore = {
  currentProfile: ApplicantProfileSchema.parse({ profileId: 'anonymous' }),
  documents: [],
  history: []
};

export async function loadStore(): Promise<PersistedApplicationStore> {
  const raw = await readJsonFile(STORE_FILE, DEFAULT_STORE);
  const profileResult = ApplicantProfileSchema.safeParse(raw.currentProfile);
  return {
    ...raw,
    currentProfile: profileResult.success ? profileResult.data : DEFAULT_STORE.currentProfile
  };
}

export async function saveStore(store: PersistedApplicationStore): Promise<void> {
  await writeJsonFile(STORE_FILE, store);
}

export async function ingestDocuments(request: ProfileBuildRequest): Promise<PersistedApplicationStore> {
  const store = await loadStore();
  const normalizedIncoming = await Promise.all(request.documents.map((document) => normalizeDocumentText(document)));
  const nextDocuments = [...store.documents.filter((document) => !normalizedIncoming.some((incoming) => incoming.documentId === document.documentId)), ...normalizedIncoming];
  const nextProfile = buildApplicantProfile({ ...request, documents: nextDocuments });

  const nextStore: PersistedApplicationStore = {
    currentProfile: nextProfile,
    documents: nextDocuments,
    history: [
      ...store.history,
      {
        type: 'profile.ingest',
        profileId: nextProfile.profileId,
        documentCount: request.documents.length,
        timestamp: new Date().toISOString()
      }
    ].slice(-250)
  };

  await saveStore(nextStore);
  return nextStore;
}

export async function appendHistory(entry: Record<string, unknown>): Promise<PersistedApplicationStore> {
  const store = await loadStore();
  const nextStore: PersistedApplicationStore = {
    ...store,
    history: [...store.history, entry].slice(-250)
  };

  await saveStore(nextStore);
  return nextStore;
}

