import { ApplicantProfileSchema, type ApplicantProfile, type GroundingFact } from '@lsc-ai/shared';

export interface DocumentInput {
  documentId: string;
  kind: 'resume' | 'cover-letter' | 'certificate' | 'portfolio' | 'job-description' | 'application-history' | 'other';
  title: string;
  text: string;
  mimeType?: string;
  base64?: string;
}

export interface ProfileBuildRequest {
  profileId: string;
  fullName?: string;
  documents: DocumentInput[];
  answerStyle?: ApplicantProfile['answerStyle'];
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/g)
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

function extractEmail(text: string): string | undefined {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function extractPhone(text: string): string | undefined {
  return text.match(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}/)?.[0];
}

function extractLinks(text: string): string[] {
  return Array.from(text.matchAll(/https?:\/\/[^\s)\]]+/gi)).map((match) => match[0]);
}

function extractSkills(text: string): string[] {
  const lines = normalizeLines(text);
  const skillHeadingIndex = lines.findIndex((line) => /skills|tooling|technologies|stack/i.test(line));

  if (skillHeadingIndex >= 0) {
    return lines.slice(skillHeadingIndex + 1, skillHeadingIndex + 8).flatMap((line) => line.split(/[,|/]/g)).map((item) => item.trim()).filter(Boolean);
  }

  return Array.from(new Set((text.match(/\b(?:typescript|javascript|react|node\.js|fastify|python|sql|aws|ollama|docker|kubernetes|graphql|redux|vue|nuxt|next\.js)\b/gi) ?? []).map((skill) => skill.toLowerCase())));
}

function extractHighlights(text: string): string[] {
  return normalizeLines(text)
    .filter((line) => line.length > 24)
    .filter((line) => /built|led|shipped|designed|implemented|reduced|improved|automated|created/i.test(line))
    .slice(0, 8);
}

function extractSummary(documents: DocumentInput[]): string | undefined {
  const resume = documents.find((document) => document.kind === 'resume' || document.kind === 'cover-letter');
  if (!resume) {
    return undefined;
  }

  const lines = normalizeLines(resume.text);
  return lines.slice(0, 4).join(' ');
}

const NAME_SKIP = /^(resume|cv|curriculum vitae|education|work experience|experience|skills|technologies|stack|tooling|contact|profile|objective|summary|references|certifications?|projects?|awards?|publications?|languages?|interests?|activities|portfolio|about me)$/i;

function extractName(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 15)) {
    // 2-4 title-case words, no digits, max 50 chars, not a section heading
    if (/^[A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-]+){1,3}$/.test(line) && line.length <= 50 && !NAME_SKIP.test(line)) {
      return line;
    }
  }
  return undefined;
}

export function buildApplicantProfile(request: ProfileBuildRequest): ApplicantProfile {
  const combinedText = request.documents.map((document) => document.text).join('\n');
  const links = extractLinks(combinedText);
  const skills = extractSkills(combinedText);
  const experienceHighlights = extractHighlights(combinedText);
  const email = extractEmail(combinedText);
  const phone = extractPhone(combinedText);
  const summary = extractSummary(request.documents);

  // Try to extract name from document text when caller didn't provide one
  const resumeDoc = request.documents.find((d) => d.kind === 'resume' || d.kind === 'cover-letter');
  const extractedName = !request.fullName && resumeDoc ? extractName(resumeDoc.text) : undefined;
  const fullName = request.fullName ?? extractedName;

  const facts: GroundingFact[] = [
    fullName ? { sourceId: 'profile.fullName', label: 'Full name', value: fullName, confidence: request.fullName ? 0.98 : 0.85 } : null,
    email ? { sourceId: 'profile.email', label: 'Email', value: email, confidence: 0.99 } : null,
    phone ? { sourceId: 'profile.phone', label: 'Phone', value: phone, confidence: 0.98 } : null,
    summary ? { sourceId: 'profile.summary', label: 'Summary', value: summary, confidence: 0.72 } : null
  ].filter((item): item is GroundingFact => item !== null);

  return ApplicantProfileSchema.parse({
    profileId: request.profileId,
    fullName,
    summary,
    email,
    phone,
    skills,
    experienceHighlights,
    portfolioLinks: links,
    facts,
    answerStyle: request.answerStyle ?? { tone: 'balanced' },
    sourceDocuments: request.documents.map((document) => ({
      documentId: document.documentId,
      kind: document.kind,
      title: document.title,
      extractedText: document.text
    }))
  });
}
