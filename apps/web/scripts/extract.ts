/**
 * Phase 0: run the extraction over a folder of form photos and print what the product would do.
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @accountdrop/web run extract ./forms
 *
 * Uses the default template. Photos should be real WhatsApp-compressed images, not scans.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import defaultTemplate from '../app/data/default-template.json' with { type: 'json' };
import { summaryMessage } from '../app/lib/conversation.ts';
import { evaluate } from '../app/lib/rules.ts';
import { parseTemplate } from '../app/lib/template.ts';
import { extract } from '../app/services/extraction.server.ts';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: extract <folder of images>');
  process.exit(1);
}
const template = parseTemplate(defaultTemplate);
const client = new Anthropic();
const model = process.env.EXTRACTION_MODEL ?? 'claude-opus-5-5';
const types: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

for (const name of readdirSync(folder).sort()) {
  const type = types[extname(name).toLowerCase()];
  if (!type) continue;
  const bytes = new Uint8Array(readFileSync(join(folder, name)));
  const started = Date.now();
  const result = await extract(client, model, {
    template,
    images: [{ bytes, contentType: type }],
    text: '',
    existing: {},
    asked: [],
  });
  const evaluation = evaluate(template, result.fields);
  console.log(
    `\n=== ${name} (${Date.now() - started} ms) form=${result.isAccountForm} unreadable=${result.unreadableReason ?? '-'}`,
  );
  console.log(JSON.stringify(evaluation.data, null, 2));
  console.log(`missing: ${evaluation.missing.join(', ') || 'none'}`);
  console.log(
    `flags: ${evaluation.flags.map((f) => `${f.key} (${f.problem})`).join(', ') || 'none'}`,
  );
  console.log(`illegible: ${result.illegible.join(', ') || 'none'}`);
  console.log('\n--- reply the rep would get ---');
  console.log(summaryMessage({ template, data: evaluation.data, evaluation }));
}
