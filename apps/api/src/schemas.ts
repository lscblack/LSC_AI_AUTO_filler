import { z } from 'zod';
import { ApplicantProfileSchema, DocumentKindSchema, FormSnapshotSchema } from '@lsc-ai/shared';

export const DocumentInputSchema = z.object({
  documentId: z.string().min(1),
  kind: DocumentKindSchema,
  title: z.string().min(1),
  text: z.string().default(''),
  mimeType: z.string().optional(),
  base64: z.string().optional()
});

export const ProfileIngestRequestSchema = z.object({
  profileId: z.string().min(1),
  fullName: z.string().optional(),
  answerStyle: ApplicantProfileSchema.shape.answerStyle.optional(),
  documents: z.array(DocumentInputSchema).min(1)
});

export const ProfilePatchRequestSchema = z.object({
  profileId: z.string().min(1),
  fullName: z.string().optional(),
  answerStyle: ApplicantProfileSchema.shape.answerStyle.optional(),
  documents: z.array(DocumentInputSchema).min(1)
});

export const DraftAnswerRequestSchema = z.object({
  profile: ApplicantProfileSchema,
  question: z.string().min(1),
  companyName: z.string().optional(),
  jobTitle: z.string().optional(),
  jobDescription: z.string().optional(),
  fieldId: z.string().optional(),
  pageContent: z.string().optional(),
  provider: z.enum(['ollama', 'openai', 'anthropic']).optional(),
  model: z.string().optional(),
  apiKey: z.string().optional()
});

export const FormAnalysisRequestSchema = FormSnapshotSchema;
