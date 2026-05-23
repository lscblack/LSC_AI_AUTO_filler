import { Buffer } from 'node:buffer';
import type { DocumentInput } from './profile-builder.js';

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfParseModule = await import('pdf-parse');
  const pdfParse = 'default' in pdfParseModule ? pdfParseModule.default : pdfParseModule;
  const result = await pdfParse(buffer);
  return result.text ?? '';
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? '';
}

export async function normalizeDocumentText(document: DocumentInput): Promise<DocumentInput> {
  if (document.text.trim()) {
    return document;
  }

  if (!document.base64) {
    return document;
  }

  const buffer = decodeBase64(document.base64);
  const mimeType = document.mimeType?.toLowerCase() ?? '';
  const title = document.title.toLowerCase();

  if (mimeType.includes('pdf') || title.endsWith('.pdf')) {
    return { ...document, text: (await extractPdfText(buffer)).trim() };
  }

  if (mimeType.includes('word') || title.endsWith('.docx')) {
    return { ...document, text: (await extractDocxText(buffer)).trim() };
  }

  return { ...document, text: buffer.toString('utf8').trim() };
}
