import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  fieldsOf,
  type ApplicationData,
  type FieldDef,
  type TemplateDefinition,
} from '../lib/template';

/**
 * Reads a photographed (or typed) application with Claude's vision, constrained to the fields
 * the tenant's template defines through structured outputs. The model transcribes; it never
 * guesses. Anything it cannot read goes in `illegible`, anything absent stays null, and the
 * rules engine (lib/rules.ts) decides what that means.
 */
export interface ExtractionImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface ExtractionInput {
  template: TemplateDefinition;
  images: ExtractionImage[];
  /** Free text the rep sent with (or instead of) the photo. */
  text: string;
  /** What we already hold, so a text reply like "DOB 14/03/1980" updates the right field. */
  existing: ApplicationData;
  /** Keys the bot just asked for; a bare answer most likely belongs to the first of them. */
  asked: string[];
}

export interface ExtractionResult {
  isAccountForm: boolean;
  fields: ApplicationData;
  illegible: string[];
  /** Short reason when the image could not be used, for the retake message. */
  unreadableReason: string | null;
}

const fieldLine = (f: FieldDef): string => {
  const parts = [`- ${f.key} (${f.type}): ${f.label}`];
  if (f.options) parts.push(` one of: ${f.options.join(' | ')}`);
  if (f.hint) parts.push(`. ${f.hint}`);
  return parts.join('');
};

/** The structured-output schema: every template field as a nullable string, plus bookkeeping. */
export const extractionSchema = (template: TemplateDefinition) => {
  const shape: Record<string, z.ZodNullable<z.ZodString>> = {};
  for (const f of fieldsOf(template)) shape[f.key] = z.string().nullable();
  return z.object({
    is_account_form: z.boolean(),
    unreadable_reason: z.string().nullable(),
    fields: z.object(shape),
    illegible: z.array(z.string()),
  });
};

export const buildPrompt = (input: ExtractionInput): { system: string; user: string } => {
  const { template } = input;
  const system = [
    'You transcribe UK trade credit account application forms for a distributor.',
    'You are given photos of a paper form and/or a text message from the sales rep, and the data already captured.',
    'Rules:',
    '- Transcribe exactly what is written. Never invent, infer or autocorrect a value. If a box is blank, the field is null.',
    '- If part of a value is unreadable, put the field key in `illegible` and set the field to null rather than guessing.',
    '- Dates as written (day first in the UK). Amounts as written. Keep names and addresses as written, fixing only obvious case.',
    '- For yes_no fields about signatures or ticks, answer "yes" only if the mark is actually visible.',
    '- If the images are not an account application form (a different document, a random photo), set is_account_form=false and give a one-line unreadable_reason.',
    '- If the photo is an account form but too blurry, dark or cropped to read the main fields, set is_account_form=true and give a one-line unreadable_reason saying what to retake (e.g. "the address block on page 1 is out of focus").',
    '- A text message from the rep may answer earlier questions: map each answer to the right field key. A bare answer with no label belongs to the first asked field it plausibly fits.',
    '- Return null for every field you have no evidence for; the existing data is kept automatically.',
  ].join('\n');
  const fieldList = template.sections
    .map((s) => `${s.title}:\n${s.fields.map(fieldLine).join('\n')}`)
    .join('\n\n');
  const existing = Object.entries(input.existing)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('\n');
  const user = [
    `Form: ${template.name}. ${template.description ?? ''}`.trim(),
    '',
    'Fields to capture:',
    fieldList,
    '',
    existing
      ? `Already captured (do not repeat unless corrected):\n${existing}`
      : 'Nothing captured yet.',
    '',
    input.asked.length > 0 ? `Fields just asked for: ${input.asked.join(', ')}` : '',
    input.text ? `Rep's message:\n"""\n${input.text}\n"""` : 'No text from the rep.',
    input.images.length > 0 ? `${input.images.length} image(s) attached.` : 'No images attached.',
  ]
    .filter((x) => x !== '')
    .join('\n');
  return { system, user };
};

const toMediaType = (
  ct: string,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null => {
  const c = ct.toLowerCase().split(';')[0]!.trim();
  if (c === 'image/jpeg' || c === 'image/jpg') return 'image/jpeg';
  if (c === 'image/png') return 'image/png';
  if (c === 'image/webp') return 'image/webp';
  if (c === 'image/gif') return 'image/gif';
  return null;
};

export const extract = async (
  client: Anthropic,
  model: string,
  input: ExtractionInput,
): Promise<ExtractionResult> => {
  const { system, user } = buildPrompt(input);
  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of input.images) {
    const mediaType = toMediaType(img.contentType);
    if (mediaType) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: Buffer.from(img.bytes).toString('base64'),
        },
      });
    } else if (img.contentType.toLowerCase().startsWith('application/pdf')) {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from(img.bytes).toString('base64'),
        },
      });
    }
  }
  content.push({ type: 'text', text: user });
  const schema = extractionSchema(input.template);
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(schema) },
  });
  const parsed = response.parsed_output;
  if (!parsed) {
    return {
      isAccountForm: true,
      fields: {},
      illegible: [],
      unreadableReason: 'the response could not be parsed',
    };
  }
  const fields: ApplicationData = {};
  for (const [k, v] of Object.entries(parsed.fields)) fields[k] = v;
  return {
    isAccountForm: parsed.is_account_form,
    fields,
    illegible: parsed.illegible,
    unreadableReason: parsed.unreadable_reason,
  };
};
