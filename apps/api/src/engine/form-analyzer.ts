import { compactText, normalizeText, type FormField, type FormSnapshot } from '@lsc-ai/shared';

export type FillStrategy = 'deterministic' | 'contextual' | 'manual_review';

export interface FieldSuggestion {
  fieldId: string;
  label: string;
  strategy: FillStrategy;
  confidence: number;
  reason: string;
  proposedValue?: string;
}

export interface FormAnalysis {
  snapshotId: string;
  siteHost: string;
  summary: string;
  needsHumanReview: boolean;
  suggestions: FieldSuggestion[];
}

const deterministicHints = [
  { token: 'email', value: 'email' },
  { token: 'e-mail', value: 'email' },
  { token: 'phone', value: 'phone' },
  { token: 'mobile', value: 'phone' },
  { token: 'linkedin', value: 'linkedin' },
  { token: 'portfolio', value: 'portfolio' },
  { token: 'website', value: 'website' },
  { token: 'url', value: 'website' },
  { token: 'github', value: 'github' },
  { token: 'first name', value: 'firstName' },
  { token: 'last name', value: 'lastName' },
  { token: 'full name', value: 'fullName' }
];

function fieldText(field: FormField): string {
  return normalizeText([field.label, field.name, field.placeholder, field.autocomplete, field.ariaLabel, field.inferredIntent].filter(Boolean).join(' '));
}

function inferStrategy(field: FormField): FieldSuggestion {
  const text = fieldText(field);

  for (const hint of deterministicHints) {
    if (text.includes(hint.token)) {
      return {
        fieldId: field.id,
        label: field.label,
        strategy: 'deterministic',
        confidence: 0.95,
        reason: `Matched deterministic hint: ${hint.token}`,
        proposedValue: hint.value
      };
    }
  }

  if (field.kind === 'textarea' || field.kind === 'rich-text') {
    return {
      fieldId: field.id,
      label: field.label,
      strategy: 'contextual',
      confidence: 0.72,
      reason: 'Open-ended prompt needs grounded generation'
    };
  }

  if (field.kind === 'select' || field.kind === 'radio' || field.kind === 'checkbox') {
    return {
      fieldId: field.id,
      label: field.label,
      strategy: 'manual_review',
      confidence: 0.68,
      reason: 'Selection should be verified against the user profile and site context'
    };
  }

  if (text.includes('?') || text.includes('why ') || text.includes('describe ') || text.includes('tell us')) {
    return {
      fieldId: field.id,
      label: field.label,
      strategy: 'contextual',
      confidence: 0.66,
      reason: 'Question-like prompt requires reasoning over profile evidence'
    };
  }

  return {
    fieldId: field.id,
    label: field.label,
    strategy: 'manual_review',
    confidence: 0.52,
    reason: 'Field intent is ambiguous and should be reviewed'
  };
}

export function analyzeForm(snapshot: FormSnapshot): FormAnalysis {
  const suggestions = snapshot.fields.map(inferStrategy);
  const needsHumanReview = suggestions.some((suggestion) => suggestion.strategy !== 'deterministic' && suggestion.confidence < 0.8);

  return {
    snapshotId: snapshot.formId,
    siteHost: snapshot.siteHost,
    summary: `${snapshot.fields.length} fields detected on ${snapshot.siteHost}`,
    needsHumanReview,
    suggestions
  };
}

export function summarizeSnapshot(snapshot: FormSnapshot): string {
  const titles = snapshot.fields.slice(0, 6).map((field) => compactText(field.label || field.name || field.id));
  return titles.join(', ');
}
