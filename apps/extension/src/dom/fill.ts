import type { FormField, ApplicantProfile } from '@lsc-ai/shared';

export interface FillPlanItem {
  field: FormField;
  value: string;
  strategy: 'deterministic' | 'contextual';
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, '\\"');
}

// Recursively searches shadow roots when a direct query on `root` misses.
function queryWithShadow(selector: string, root: ParentNode): HTMLElement | null {
  const direct = root.querySelector(selector);
  if (direct instanceof HTMLElement) return direct;

  for (const el of Array.from(root.querySelectorAll('*'))) {
    const shadow = (el as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
      const found = queryWithShadow(selector, shadow);
      if (found) return found;
    }
  }
  return null;
}

function queryAllWithShadow(selector: string, root: ParentNode): HTMLElement[] {
  const results: HTMLElement[] = Array.from(root.querySelectorAll(selector)).filter(
    (el): el is HTMLElement => el instanceof HTMLElement
  );
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const shadow = (el as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
      results.push(...queryAllWithShadow(selector, shadow));
    }
  }
  return results;
}

export function findFieldElement(field: FormField, root: ParentNode = document): HTMLElement | null {
  if (field.selectorHint) {
    const direct = queryWithShadow(field.selectorHint, root);
    if (direct) return direct;
  }

  if (field.id) {
    const byId = queryWithShadow(`#${CSS.escape(field.id)}`, root);
    if (byId) return byId;
  }

  if (field.name) {
    const byName = queryWithShadow(`[name="${escapeAttribute(field.name)}"]`, root);
    if (byName) return byName;
  }

  const labels = queryAllWithShadow('label', root);
  const label = labels.find((node) => node.textContent?.trim() === field.label.trim());
  if (label) {
    const labelFor = label.getAttribute('for');
    if (labelFor) {
      const associated = queryWithShadow(`#${CSS.escape(labelFor)}`, root);
      if (associated) return associated;
    }

    const wrapped = label.querySelector('input, textarea, select, [contenteditable="true"]');
    if (wrapped instanceof HTMLElement) return wrapped;
  }

  return null;
}

function findRadioGroupFieldElement(field: FormField, root: ParentNode = document): HTMLInputElement | null {
  const radios = queryAllWithShadow('input[type="radio"]', root).filter(
    (el): el is HTMLInputElement => el instanceof HTMLInputElement
  );
  const normalizedLabel = field.label.trim().toLowerCase();

  for (const radio of radios) {
    const radioLabel = [radio.getAttribute('aria-label'), radio.getAttribute('name'), radio.id, radio.value, radio.closest('label')?.textContent]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (radioLabel.includes(normalizedLabel) || normalizedLabel.includes(radioLabel)) {
      return radio;
    }
  }

  return null;
}

function findCheckboxFieldElement(field: FormField, root: ParentNode = document): HTMLInputElement | null {
  const checkboxes = queryAllWithShadow('input[type="checkbox"]', root).filter(
    (el): el is HTMLInputElement => el instanceof HTMLInputElement
  );
  const normalizedLabel = field.label.trim().toLowerCase();

  for (const checkbox of checkboxes) {
    const checkboxLabel = [checkbox.getAttribute('aria-label'), checkbox.getAttribute('name'), checkbox.id, checkbox.value, checkbox.closest('label')?.textContent]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (checkboxLabel.includes(normalizedLabel) || normalizedLabel.includes(checkboxLabel)) {
      return checkbox;
    }
  }

  return null;
}

export function setNativeValue(element: HTMLElement, value: string): void {
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    const matching = value.trim().toLowerCase();
    const checked = [element.value, element.getAttribute('aria-label'), element.closest('label')?.textContent]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(matching);

    if (checked) {
      element.checked = true;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }

  if (element instanceof HTMLInputElement && element.type === 'checkbox') {
    const normalized = value.trim().toLowerCase();
    const shouldCheck =
      ['yes', 'true', 'checked', 'on'].includes(normalized) ||
      normalized.includes(element.value.trim().toLowerCase()) ||
      normalized.includes('accept') ||
      normalized.includes('agree');
    element.checked = shouldCheck;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (element instanceof HTMLSelectElement) {
    const nextOption = Array.from(element.options).find(
      (option) =>
        option.value === value ||
        option.textContent?.trim().toLowerCase() === value.trim().toLowerCase()
    );
    if (nextOption) {
      element.value = nextOption.value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = Object.getPrototypeOf(element);
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (element.getAttribute('contenteditable') === 'true') {
    element.textContent = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function fillDeterministicField(field: FormField, profile: ApplicantProfile): string | null {
  const normalizedLabel = `${field.label} ${field.name ?? ''} ${field.autocomplete ?? ''} ${field.selectorHint ?? ''}`.toLowerCase();

  if (normalizedLabel.includes('email') && profile.email) return profile.email;
  if ((normalizedLabel.includes('phone') || normalizedLabel.includes('mobile')) && profile.phone) return profile.phone;

  if (profile.fullName) {
    const nameParts = profile.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? profile.fullName;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : profile.fullName;

    if (normalizedLabel.includes('first name') || normalizedLabel.includes('firstname') || normalizedLabel.includes('given name') || normalizedLabel.includes('first-name')) {
      return firstName;
    }
    if (normalizedLabel.includes('last name') || normalizedLabel.includes('lastname') || normalizedLabel.includes('surname') || normalizedLabel.includes('family name') || normalizedLabel.includes('last-name')) {
      return lastName;
    }
    if (normalizedLabel.includes('name')) return profile.fullName;
  }

  if (
    (normalizedLabel.includes('linkedin') ||
      normalizedLabel.includes('portfolio') ||
      normalizedLabel.includes('website') ||
      normalizedLabel.includes('github')) &&
    profile.portfolioLinks.length > 0
  ) {
    // Match each platform by URL keyword before falling back to the first link.
    if (normalizedLabel.includes('linkedin')) {
      return profile.portfolioLinks.find((url) => url.toLowerCase().includes('linkedin')) ?? profile.portfolioLinks[0] ?? null;
    }
    if (normalizedLabel.includes('github')) {
      return profile.portfolioLinks.find((url) => url.toLowerCase().includes('github')) ?? profile.portfolioLinks[0] ?? null;
    }
    // Portfolio / website — prefer a non-social link if one exists.
    return (
      profile.portfolioLinks.find(
        (url) => !url.toLowerCase().includes('linkedin') && !url.toLowerCase().includes('github')
      ) ?? profile.portfolioLinks[0] ?? null
    );
  }

  if (field.kind === 'radio') {
    if (normalizedLabel.includes('yes') || normalizedLabel.includes('no')) {
      return normalizedLabel.includes('yes') ? 'yes' : 'no';
    }
    if (normalizedLabel.includes('authorized') || normalizedLabel.includes('work authorization')) {
      return 'yes';
    }
  }

  if (field.kind === 'checkbox') {
    if (normalizedLabel.includes('terms') || normalizedLabel.includes('agree') || normalizedLabel.includes('consent')) {
      return 'true';
    }
  }

  return null;
}

export function resolveInteractiveFieldElement(field: FormField, root: ParentNode = document): HTMLElement | null {
  if (field.kind === 'radio') {
    return findRadioGroupFieldElement(field, root);
  }

  if (field.kind === 'checkbox') {
    return findCheckboxFieldElement(field, root);
  }

  return findFieldElement(field, root);
}
