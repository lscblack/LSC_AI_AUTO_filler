import { compactText, type AnswerDraft, type ApplicantProfile, type FormField } from '@lsc-ai/shared';
import { generateWithOllama } from './ollama.js';

export interface DraftAnswerRequest {
  question: string;
  profile: ApplicantProfile;
  jobTitle?: string;
  companyName?: string;
  jobDescription?: string;
  pageContent?: string;
  field?: FormField;
  provider?: 'ollama' | 'openai' | 'anthropic';
  model?: string;
  apiKey?: string;
}

// ── identity field resolver (no AI needed) ────────────────────────────────────

function resolveIdentityField(question: string, profile: ApplicantProfile): string | null {
  const q = question.trim().toLowerCase().replace(/[*:?]/g, '').trim();

  if (/^first\s*name$|^given\s*name$|^forename$|^first-name$/.test(q)) {
    return profile.fullName ? (profile.fullName.trim().split(/\s+/)[0] ?? null) : null;
  }
  if (/^last\s*name$|^surname$|^family\s*name$|^last-name$/.test(q)) {
    if (profile.fullName) {
      const parts = profile.fullName.trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : parts[0] ?? null;
    }
    return null;
  }
  if (/^middle\s*name$/.test(q)) return '';
  if (/^(?:full\s*)?name$|^your\s*name$|^applicant\s*name$/.test(q)) return profile.fullName ?? null;
  if (/^email(?:\s*address)?$/.test(q)) return profile.email ?? null;
  if (/^phone(?:\s*number)?$|^mobile(?:\s*(?:number|phone))?$|^telephone$/.test(q)) return profile.phone ?? null;

  return null;
}

// ── external provider generators ──────────────────────────────────────────────

interface GenerationResult {
  text: string;
  model: string;
}

async function generateWithOpenAI(prompt: string, model: string, apiKey: string): Promise<GenerationResult | null> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.3
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? { text, model: model || 'gpt-4o-mini' } : null;
  } catch {
    return null;
  }
}

async function generateWithAnthropic(prompt: string, model: string, apiKey: string): Promise<GenerationResult | null> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim();
    return text ? { text, model: model || 'claude-haiku-4-5-20251001' } : null;
  } catch {
    return null;
  }
}

// ── prompt builders ───────────────────────────────────────────────────────────

function buildDocumentContext(profile: ApplicantProfile): string {
  const docs = profile.sourceDocuments
    .filter((d) => d.extractedText?.trim())
    .map((d) => `--- ${d.kind.toUpperCase()}: ${d.title} ---\n${d.extractedText!.trim()}`)
    .join('\n\n');
  return docs.slice(0, 7000);
}

function buildProfileSummary(profile: ApplicantProfile): string {
  const lines: string[] = [];
  if (profile.fullName) lines.push(`Name: ${profile.fullName}`);
  if (profile.email) lines.push(`Email: ${profile.email}`);
  if (profile.phone) lines.push(`Phone: ${profile.phone}`);
  if (profile.location) lines.push(`Location: ${profile.location}`);
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.summary) lines.push(`Summary: ${profile.summary}`);
  if (profile.skills.length) lines.push(`Skills: ${profile.skills.join(', ')}`);
  if (profile.experienceHighlights.length) lines.push(`Experience: ${profile.experienceHighlights.join(' | ')}`);
  if (profile.education.length) lines.push(`Education: ${profile.education.join(' | ')}`);
  if (profile.certifications.length) lines.push(`Certifications: ${profile.certifications.join(', ')}`);
  if (profile.portfolioLinks.length) lines.push(`Links: ${profile.portfolioLinks.join(', ')}`);
  return lines.join('\n');
}

function buildFallbackAnswer(request: DraftAnswerRequest): string {
  const q = compactText(request.question).toLowerCase();
  const p = request.profile;

  if (q.includes('email') && p.email) return p.email;
  if ((q.includes('phone') || q.includes('mobile')) && p.phone) return p.phone;
  if (q.includes('name') && !q.includes('company') && p.fullName) return p.fullName;
  if ((q.includes('linkedin') || q.includes('portfolio') || q.includes('website') || q.includes('github')) && p.portfolioLinks.length) {
    return p.portfolioLinks[0]!;
  }
  if (q.includes('location') || q.includes('city') || q.includes('where are you')) {
    return p.location ?? 'Available for remote or on-site';
  }

  const company = request.companyName ? ` at ${request.companyName}` : '';
  const role = request.jobTitle ? `${request.jobTitle}` : 'this role';
  const skills = p.skills.slice(0, 4).join(', ');
  const exp = p.experienceHighlights[0];

  if (q.includes('why') || q.includes('interest') || q.includes('motivat') || q.includes('passion')) {
    return [
      `I am drawn to ${role}${company} because it aligns closely with my background in ${skills || 'my field'}.`,
      exp ? exp : null,
      `I am eager to contribute my expertise and continue growing in this area.`
    ].filter(Boolean).join(' ');
  }

  if (q.includes('experience') || q.includes('background') || q.includes('describe yourself') || q.includes('tell us about')) {
    return [
      p.headline ?? `I am a professional with experience in ${skills || 'my field'}.`,
      exp ?? null,
      p.summary ?? null
    ].filter(Boolean).join(' ');
  }

  if (q.includes('skill') || q.includes('strength') || q.includes('expertise')) {
    return skills
      ? `My core strengths include ${skills}. ${exp ?? ''}`.trim()
      : p.summary ?? 'I bring a strong technical and problem-solving skill set.';
  }

  if (q.includes('salary') || q.includes('compensation') || q.includes('expectation')) {
    return 'Negotiable based on the overall compensation package and role responsibilities.';
  }

  if (q.includes('availability') || q.includes('start date') || q.includes('notice')) {
    return 'I am available to start with reasonable notice and am flexible to align with your timeline.';
  }

  if (q.includes('authorized') || q.includes('work authorization') || q.includes('visa')) {
    return 'Yes, I am authorized to work.';
  }

  return [
    p.headline ?? `I am an experienced professional with expertise in ${skills || 'my field'}.`,
    exp ?? p.summary ?? null
  ].filter(Boolean).join(' ');
}

// ── main composer ─────────────────────────────────────────────────────────────

export async function composeDraftAnswer(request: DraftAnswerRequest): Promise<AnswerDraft> {
  // Short identity fields — return directly from profile, no AI needed
  const identityValue = resolveIdentityField(request.question, request.profile);
  if (identityValue !== null) {
    return {
      answer: identityValue,
      confidence: 0.97,
      groundingNotes: ['Direct profile match — no AI used'],
      shouldReview: false,
      sourceFacts: []
    };
  }

  const docContext = buildDocumentContext(request.profile);
  const profileSummary = buildProfileSummary(request.profile);

  const contextSection = docContext
    ? `=== APPLICANT DOCUMENTS ===\n${docContext}`
    : `=== APPLICANT PROFILE ===\n${profileSummary}`;

  // Use the most specific job content available, in priority order
  const jobDesc = request.jobDescription ?? request.pageContent ?? '';
  const jobDescTrimmed = jobDesc.slice(0, 5000).trim();

  const jobLines: string[] = ['=== JOB YOU ARE APPLYING FOR ==='];
  if (request.companyName) jobLines.push(`Company: ${request.companyName}`);
  if (request.jobTitle) jobLines.push(`Role: ${request.jobTitle}`);
  if (jobDescTrimmed) {
    jobLines.push('');
    jobLines.push('Job description:');
    jobLines.push(jobDescTrimmed);
  }
  const jobSection = jobLines.join('\n').trim();

  const hasJobContext = !!(request.companyName || request.jobTitle || jobDescTrimmed);

  const prompt = [
    'You are a professional job application writer. Write a precise, professional answer on behalf of the applicant.',
    '',
    'RULES:',
    '1. Write in first person ("I", "my", "me")',
    '2. ALWAYS tailor the answer to the specific role and company listed below — reference the job title, required skills, or company context wherever relevant',
    '3. Be specific — use actual details from the applicant documents (skills, tools, companies, achievements) that match what the job asks for',
    '4. Never say "Based on my resume" or "According to my documents"',
    '5. Keep short-answer fields under 2 sentences; essays under 5 sentences unless asked for more',
    '6. For identity fields (name, email, phone, city, website): output the value ONLY — no extra words',
    '7. If a required detail is missing, give a genuine professional response aligned with the role',
    '8. Start the answer immediately — no preamble, no "Certainly", no "Of course"',
    hasJobContext ? '9. Draw explicit connections between the applicant\'s experience and what this role/company needs' : '',
    '',
    contextSection,
    '',
    jobSection,
    '',
    '=== QUESTION ===',
    request.question,
    '',
    'Answer:'
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
    .trim();

  // Pick provider
  const provider = request.provider ?? 'ollama';
  let result: GenerationResult | null = null;

  if (provider === 'openai' && request.apiKey) {
    result = await generateWithOpenAI(prompt, request.model ?? '', request.apiKey);
  } else if (provider === 'anthropic' && request.apiKey) {
    result = await generateWithAnthropic(prompt, request.model ?? '', request.apiKey);
  } else {
    // Ollama (default)
    const ollamaResult = await generateWithOllama(prompt, { model: request.model });
    if (ollamaResult) result = ollamaResult;
  }

  if (result?.text) {
    return {
      answer: result.text,
      confidence: docContext ? 0.85 : 0.76,
      groundingNotes: [
        `Model: ${result.model}`,
        `Provider: ${provider}`,
        docContext ? 'Grounded in uploaded documents' : 'Generated from profile summary'
      ],
      shouldReview: true,
      sourceFacts: []
    };
  }

  const fallback = buildFallbackAnswer(request);
  return {
    answer: fallback,
    confidence: 0.65,
    groundingNotes: [`Template fallback — ${provider} unavailable`],
    shouldReview: true,
    sourceFacts: []
  };
}
