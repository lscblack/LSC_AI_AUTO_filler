import { z } from 'zod';

export const ConfidenceSchema = z.number().min(0).max(1);

export const FieldKindSchema = z.enum([
  'text',
  'email',
  'phone',
  'url',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'date',
  'number',
  'file',
  'rich-text',
  'password',
  'unknown'
]);

export const DocumentKindSchema = z.enum([
  'resume',
  'cover-letter',
  'certificate',
  'portfolio',
  'job-description',
  'application-history',
  'other'
]);

export const FieldChoiceSchema = z.object({
  label: z.string(),
  value: z.string().optional(),
  selected: z.boolean().optional()
});

export const FormFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  name: z.string().optional(),
  kind: FieldKindSchema,
  tagName: z.string(),
  selectorHint: z.string().optional(),
  placeholder: z.string().optional(),
  autocomplete: z.string().optional(),
  ariaLabel: z.string().optional(),
  required: z.boolean().default(false),
  multiline: z.boolean().default(false),
  options: z.array(FieldChoiceSchema).default([]),
  inferredIntent: z.string().optional(),
  value: z.string().optional(),
  confidence: ConfidenceSchema.default(0)
});

export const FormContextSchema = z.object({
  visibleText: z.string().optional(),
  companyHint: z.string().optional(),
  jobTitleHint: z.string().optional(),
  jobDescription: z.string().optional(),
  route: z.string().optional()
});

export const FormSnapshotSchema = z.object({
  pageUrl: z.string().url(),
  pageTitle: z.string(),
  siteHost: z.string(),
  formId: z.string(),
  formAction: z.string().optional(),
  formIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().default(0),
  stepKey: z.string().optional(),
  capturedAt: z.string(),
  fields: z.array(FormFieldSchema),
  context: FormContextSchema.default({})
});

export const GroundingFactSchema = z.object({
  sourceId: z.string(),
  label: z.string(),
  value: z.string(),
  confidence: ConfidenceSchema.default(0.5)
});

export const ApplicantProfileSchema = z.object({
  profileId: z.string(),
  fullName: z.string().optional(),
  headline: z.string().optional(),
  summary: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  skills: z.array(z.string()).default([]),
  experienceHighlights: z.array(z.string()).default([]),
  education: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  portfolioLinks: z.array(z.string()).default([]),
  facts: z.array(GroundingFactSchema).default([]),
  answerStyle: z
    .object({
      tone: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
      preference: z.string().optional()
    })
    .default({ tone: 'balanced' }),
  sourceDocuments: z.array(
    z.object({
      documentId: z.string(),
      kind: DocumentKindSchema,
      title: z.string(),
      extractedText: z.string().optional()
    })
  ).default([])
});

export const AnswerDraftSchema = z.object({
  answer: z.string(),
  confidence: ConfidenceSchema,
  groundingNotes: z.array(z.string()).default([]),
  shouldReview: z.boolean().default(true),
  sourceFacts: z.array(z.string()).default([])
});

export type FormField = z.infer<typeof FormFieldSchema>;
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;
export type ApplicantProfile = z.infer<typeof ApplicantProfileSchema>;
export type AnswerDraft = z.infer<typeof AnswerDraftSchema>;
export type GroundingFact = z.infer<typeof GroundingFactSchema>;
export type FieldKind = z.infer<typeof FieldKindSchema>;
