export interface OllamaGenerationResult {
  text: string;
  model: string;
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
}

export async function generateWithOllama(prompt: string, options: OllamaOptions = {}): Promise<OllamaGenerationResult | null> {
  const baseUrl = options.baseUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const model = options.model ?? process.env.OLLAMA_MODEL ?? 'llama3.1';

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false })
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { response?: string };
    if (!data.response) {
      return null;
    }

    return { text: data.response.trim(), model };
  } catch {
    return null;
  }
}

export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const url = baseUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}
