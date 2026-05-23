import { compactText, normalizeText, type FieldKind, type FormField, type FormSnapshot } from '@lsc-ai/shared';

const FIELD_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]'
].join(',');

function getElementLabel(element: HTMLElement): string {
  const ariaLabel = compactText(element.getAttribute('aria-label'));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = compactText(element.getAttribute('aria-labelledby'));
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id: string) => document.getElementById(id)?.textContent ?? '').filter(Boolean);
    if (parts.length > 0) {
      return compactText(parts.join(' '));
    }
  }

  const id = element.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) {
      return compactText(label.textContent);
    }
  }

  const wrappingLabel = element.closest('label');
  if (wrappingLabel?.textContent) {
    return compactText(wrappingLabel.textContent);
  }

  return compactText(element.getAttribute('placeholder')) || compactText((element as HTMLInputElement).name) || compactText((element as HTMLInputElement).type) || 'Unlabeled field';
}

function buildSelectorHint(element: HTMLElement): string | undefined {
  const id = element.getAttribute('id');
  if (id) {
    return `#${CSS.escape(id)}`;
  }

  const name = element.getAttribute('name');
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }

  return undefined;
}

function getStepKey(formOrBody: ParentNode, formIndex: number, fields: HTMLElement[]): string | undefined {
  if (formOrBody instanceof HTMLElement) {
    const explicit = compactText(formOrBody.getAttribute('data-step') || formOrBody.getAttribute('aria-label'));
    if (explicit) {
      return explicit;
    }
  }

  const legend = formOrBody.querySelector('legend');
  if (legend?.textContent) {
    return compactText(legend.textContent);
  }

  const heading = fields.map((field) => field.closest('section, fieldset, div')).find((container) => {
    const candidate = container?.querySelector('h1, h2, h3, h4, [data-step-title]');
    return Boolean(candidate?.textContent?.trim());
  });

  if (heading) {
    const candidate = heading.querySelector('h1, h2, h3, h4, [data-step-title]');
    if (candidate?.textContent) {
      return compactText(candidate.textContent);
    }
  }

  const text = compactText((formOrBody as HTMLElement).textContent);
  const stepMatch = text.match(/step\s+(\d+)\s+(?:of|\/)?\s*(\d+)?/i);
  if (stepMatch) {
    return `step-${stepMatch[1]}`;
  }

  return `form-step-${formIndex}`;
}

function inferKind(element: HTMLElement): FieldKind {
  if (element instanceof HTMLTextAreaElement) {
    return 'textarea';
  }

  if (element instanceof HTMLSelectElement) {
    return 'select';
  }

  if (element.getAttribute('contenteditable') === 'true') {
    return 'rich-text';
  }

  const role = normalizeText(element.getAttribute('role'));
  if (role === 'textbox' && element.getAttribute('contenteditable') === 'true') {
    return 'rich-text';
  }

  if (role === 'textbox') {
    return 'textarea';
  }

  if (role === 'combobox') {
    return 'select';
  }

  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case 'email':
        return 'email';
      case 'tel':
        return 'phone';
      case 'url':
        return 'url';
      case 'date':
        return 'date';
      case 'number':
        return 'number';
      case 'password':
        return 'password';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'file':
        return 'file';
      default:
        return 'text';
    }
  }

  return 'unknown';
}

function getOptions(element: HTMLSelectElement): Array<{ label: string; value?: string; selected?: boolean }> {
  return Array.from(element.options).map((option) => ({
    label: compactText(option.textContent),
    value: option.value,
    selected: option.selected
  }));
}

function extractCompanyHint(doc: Document): string | undefined {
  // Try structured meta tags first (LinkedIn, Greenhouse, Lever all use these)
  const metas = ['og:site_name', 'og:title', 'twitter:title'].map((name) => doc.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content ?? '');
  for (const meta of metas) {
    const match = meta.match(/(?:at|@|·|-)\s*([A-Z][^|·\-–]+)/);
    if (match?.[1]) return match[1].trim();
  }

  // Common class/attribute patterns used by ATS platforms
  const atsSelectors = ['[data-company-name]', '[data-organization]', '.company-name', '.employer-name', '.org-name'];
  for (const selector of atsSelectors) {
    const el = doc.querySelector(selector);
    const text = compactText(el?.textContent);
    if (text) return text;
  }

  // Headings that mention "at CompanyName" or "Company: Foo"
  for (const heading of Array.from(doc.querySelectorAll('h1, h2, h3'))) {
    const text = heading.textContent?.trim() ?? '';
    const match = text.match(/\bat\s+([A-Z][^|·\-–\n]+)/);
    if (match?.[1] && match[1].length < 60) return match[1].trim();
  }

  return undefined;
}

function extractJobTitleHint(doc: Document): string | undefined {
  // og:title often reads "Software Engineer at Acme" — grab the part before "at"
  const ogTitle = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? '';
  const titleAtMatch = ogTitle.match(/^([^|·@\-–]+?)\s+(?:at|@)/i);
  if (titleAtMatch?.[1]) return titleAtMatch[1].trim();

  // Common ATS selectors
  const atsSelectors = ['[data-job-title]', '[data-position]', '.job-title', '.position-title', '.role-title', 'h1.title', 'h1'];
  for (const selector of atsSelectors) {
    const el = doc.querySelector(selector);
    const text = compactText(el?.textContent);
    if (text && text.length < 120) return text;
  }

  // Page <title> tag — often "Job Title | Company"
  const pageTitle = compactText(doc.title);
  if (pageTitle) {
    const parts = pageTitle.split(/[|·–\-]/);
    if (parts[0] && parts[0].length < 80) return parts[0].trim();
  }

  return undefined;
}

function extractJobDescription(doc: Document): string | undefined {
  // Try known ATS / job-board selectors from most to least specific
  const selectors = [
    '[data-job-description]',
    '[data-description]',
    '#job-description',
    '#jobDescriptionText',
    '.job-description',
    '.posting-description',
    '.description__text',
    '.jobs-description__content',
    '.jobs-description-content',
    '.job-details-content',
    '.jobsearch-JobComponent-description',
    '.posting-content',
    '.content-intro',
    '.job-view-layout .description',
    '[aria-label*="job description" i]',
    '[aria-label*="description" i]',
    'section.description',
    'div.description',
  ];

  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const text = el?.textContent?.trim() ?? '';
    if (text.length > 80) return compactText(text).slice(0, 6000);
  }

  // Fallback: find the longest non-form block of prose on the page
  const candidates = Array.from(doc.querySelectorAll('main p, article p, section p, .content p'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter((t) => t.length > 40);
  if (candidates.length > 3) return compactText(candidates.join(' ')).slice(0, 6000);

  return undefined;
}

function detectIntent(label: string, element: HTMLElement): string | undefined {
  const text = normalizeText([label, element.getAttribute('name'), element.getAttribute('autocomplete')].filter(Boolean).join(' '));

  if (text.includes('email')) return 'contact.email';
  if (text.includes('phone') || text.includes('tel')) return 'contact.phone';
  if (text.includes('name')) return 'identity.name';
  if (text.includes('linkedin')) return 'profile.linkedin';
  if (text.includes('github')) return 'profile.github';
  if (text.includes('portfolio') || text.includes('website')) return 'profile.portfolio';
  if (text.includes('salary')) return 'compensation.expectation';
  if (text.includes('why') || text.includes('motivation') || text.includes('cover letter')) return 'reasoning.motivation';

  return undefined;
}

function collectFields(root: ParentNode): HTMLElement[] {
  const elements = Array.from(root.querySelectorAll(FIELD_SELECTOR)).filter((element): element is HTMLElement => element instanceof HTMLElement);
  const shadowRoots = Array.from(root.querySelectorAll('*')).flatMap((element) => {
    const shadowRoot = (element as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    return shadowRoot ? collectFields(shadowRoot) : [];
  });

  return [...elements, ...shadowRoots];
}

function collectFrameDocuments(documentNode: Document): Document[] {
  const documents: Document[] = [documentNode];

  for (const frame of Array.from(documentNode.querySelectorAll('iframe'))) {
    try {
      const frameDocument = frame.contentDocument;
      if (frameDocument) {
        documents.push(...collectFrameDocuments(frameDocument));
      }
    } catch {
      continue;
    }
  }

  return documents;
}

export function scanForms(documentNode: Document): FormSnapshot[] {
  const documents = collectFrameDocuments(documentNode);

  return documents.flatMap((doc, documentIndex) => {
    const forms = Array.from(doc.querySelectorAll('form'));
    const formGroups = forms.length > 0 ? forms : [doc.body];

    return formGroups.map((formOrBody, formIndex) => {
      const elements = collectFields(formOrBody);
    const fields: FormField[] = elements.map((element: HTMLElement, index: number) => {
      const label = getElementLabel(element);
      const kind = inferKind(element);
      const options = element instanceof HTMLSelectElement ? getOptions(element) : [];

      return {
        id: element.getAttribute('name') || element.getAttribute('id') || `${formIndex}-${index}`,
        label,
        name: element.getAttribute('name') ?? undefined,
        kind,
        tagName: element.tagName.toLowerCase(),
        selectorHint: buildSelectorHint(element),
        placeholder: compactText(element.getAttribute('placeholder')) || undefined,
        autocomplete: compactText(element.getAttribute('autocomplete')) || undefined,
        ariaLabel: compactText(element.getAttribute('aria-label')) || undefined,
        required: element.hasAttribute('required'),
        multiline: kind === 'textarea' || kind === 'rich-text',
        options,
        inferredIntent: detectIntent(label, element),
        confidence: options.length > 0 ? 0.8 : 0.64
      };
    });

      const ownerForm = formOrBody instanceof HTMLFormElement ? formOrBody : null;
      const stepKey = getStepKey(formOrBody, formIndex, elements);

      return {
        pageUrl: doc.location?.href ?? documentNode.location?.href ?? window.location.href,
        pageTitle: doc.title || documentNode.title,
        siteHost: doc.location?.host ?? documentNode.location?.host ?? window.location.host,
        formId: ownerForm?.id || `frame-${documentIndex}-form-${formIndex}`,
        formAction: ownerForm?.action || undefined,
        formIndex,
        stepIndex: formIndex,
        stepKey,
        capturedAt: new Date().toISOString(),
        fields,
        context: {
          visibleText: compactText(doc.body?.innerText?.slice(0, 8000)),
          route: window.location.pathname,
          companyHint: extractCompanyHint(doc),
          jobTitleHint: extractJobTitleHint(doc),
          jobDescription: extractJobDescription(doc)
        }
      };
    });
  });
}
