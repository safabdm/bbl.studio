import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './db';

function escapePdf(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function writeTextPdf(fileName: string, title: string, lines: string[]) {
  const wrapped: string[] = [];
  for (const line of lines) {
    const chunks = line.match(/.{1,92}/g) || [''];
    wrapped.push(...chunks);
  }
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += 44) pages.push(wrapped.slice(i, i + 44));
  const objects: string[] = [];
  const pageIds: number[] = [];
  let nextId = 3;
  const contentIds: number[] = [];
  pages.forEach((pageLines, index) => {
    const contentId = nextId++;
    const pageId = nextId++;
    contentIds.push(contentId);
    pageIds.push(pageId);
    const stream = [
      'BT',
      '/F1 16 Tf',
      '50 760 Td',
      `(${escapePdf(index === 0 ? title : `${title} (continued)`)}) Tj`,
      '/F1 10 Tf',
      '0 -28 Td',
      ...pageLines.flatMap((line) => [`(${escapePdf(line)}) Tj`, '0 -16 Td']),
      'ET',
    ].join('\n');
    objects[contentId] = `${contentId} 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream endobj`;
    objects[pageId] = `${pageId} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 1 0 R >> >> >>endobj`;
  });
  objects[1] = '1 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj';
  objects[2] = `2 0 obj<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>endobj`;
  const catalogId = nextId++;
  objects[catalogId] = `${catalogId} 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < nextId; i++) {
    offsets[i] = body.length;
    body += `${objects[i]}\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let i = 1; i < nextId; i++) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer<< /Size ${nextId} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const full = join(paths.uploads, fileName);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
}
