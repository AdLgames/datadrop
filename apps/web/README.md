# @accountdrop/web

React Router 7 (framework mode) on Vercel. One process serves the Twilio webhook, the review app
and the cron route.

## Map of the code

| Area          | Files                                                                                                                          | Notes                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template      | `app/lib/template.ts`, `app/data/default-template.json`                                                                        | Sections, fields, requirement, conditional rules, ask phrasing. Three keys are protected.                                                                                                                                                                      |
| Rules engine  | `app/lib/rules.ts`, `app/lib/validators.ts`                                                                                    | Effective requirement per field, missing and flagged lists, UK normalisers (postcode, company no, VAT, sort code, phone, dates, money as decimal strings).                                                                                                     |
| Conversation  | `app/lib/conversation.ts`                                                                                                      | Every WhatsApp reply. Sensitive fields are read back as "provided".                                                                                                                                                                                            |
| Messaging     | `app/lib/messaging.ts`, `app/lib/twilio.ts`, `app/lib/meta.ts`, `app/services/twilio.server.ts`, `app/services/meta.server.ts` | One inbound shape and one provider interface. Twilio: HMAC-SHA1 signature, TwiML, REST send and media fetch. Meta Cloud API: verify handshake, sha256 signature, Graph API send and media download. Replies go back through the provider a message arrived on. |
| Extraction    | `app/services/extraction.server.ts`                                                                                            | Claude vision with structured outputs compiled from the template. Transcribe, never guess; `illegible` list; retake reasons.                                                                                                                                   |
| Intake        | `app/services/intake.server.ts`                                                                                                | The pipeline: dedupe, resolve rep, store media, extract on every page so far, merge, evaluate, quiet period, reply; YES submits and emails credit control. Stale (48 h) applications expire; a photo of a different company splits into a new application.     |
| Lookups       | `app/services/lookups.server.ts`                                                                                               | Companies House (status, name, registered address) and postcodes.io.                                                                                                                                                                                           |
| Data          | `app/services/db.server.ts`, `app/services/supabase.server.ts`                                                                 | Row types, service client (webhook, cron, admin writes) vs user client (RLS).                                                                                                                                                                                  |
| Auth          | `app/services/auth.server.ts`, `routes/login*.tsx`                                                                             | Supabase email OTP, invite-only, domain lock, first-sign-in linking, same-origin check on every form.                                                                                                                                                          |
| Review app    | `routes/app*.tsx`                                                                                                              | Queue with filters, detail with original images (same-origin proxy), approve / return / reject, reps, users and company settings, form settings (new version per save), audit log.                                                                             |
| Notifications | `app/services/notify.server.ts`, `email.server.ts`                                                                             | Email on submission (key fields only, no personal data), WhatsApp decision to the rep.                                                                                                                                                                         |
| Retention     | `routes/api.cron.retention.tsx`                                                                                                | Deletes images past `delete_after` (set at decision time from the tenant's retention days) and expires stale applications.                                                                                                                                     |
| Hardening     | `app/entry.server.tsx`, `security-headers.server.ts`, `logger.server.ts`                                                       | CSP with nonce, HSTS, no framing; JSON logs with phones, emails, bodies and personal fields redacted.                                                                                                                                                          |

## Environment

See the root `.env.example`. Nothing here is optional in production except `COMPANIES_HOUSE_API_KEY`
(lookup off) and `REPLY_QUIET_SECONDS`.

## Scripts

- `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`
- `pnpm run extract <folder>`: Phase 0 tool. Runs the extraction over every image in a folder with
  the default template and prints the fields, the missing list and the flags per form. Needs
  `ANTHROPIC_API_KEY`.

## Tests

Unit tests cover the validators, the rules engine against the default template, the conversation
copy, the Twilio signature (Twilio's documented vector), the extraction prompt and schema, the
lookups, and the whole intake pipeline against in-memory fakes (dedupe, quiet period, YES, status
replies, retakes, non-forms, expiry).
