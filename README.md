# AccountDrop

Sales reps WhatsApp a photo of a signed trade-account form. AccountDrop reads it, asks the rep for
anything missing, checks the company on Companies House, gets the rep to confirm, and hands credit
control a complete application with the original image attached. Credit control approves, returns or
rejects it from a review queue; the rep gets the decision on WhatsApp.

```
Rep (WhatsApp) ─► Twilio ─► /webhooks/twilio ─► store message + image (private bucket)
                                                 │  extract with Claude vision (template-driven)
                                                 │  rules engine → missing / flagged fields
                                                 │  quiet period → reply (ask / confirm)
                                                 ▼
                                      YES → submitted → email credit control → review queue
                                                 ▼
                                   approve / return / reject → WhatsApp status to the rep
```

One app (`apps/web`, React Router 7 on Vercel) plus Supabase (Postgres with row-level security, Auth
with 6-digit email codes, private Storage). No Edge Functions, no worker.

- **Setup and go-live checklist:** [`docs/setup.md`](docs/setup.md)
- **How it works, file by file:** [`apps/web/README.md`](apps/web/README.md)
- **Phase 0 extraction script** (run the model over a folder of real forms, no product code):
  `pnpm --filter @accountdrop/web run extract ./forms`

## Develop

```sh
pnpm install
cp .env.example apps/web/.env   # fill in the keys
pnpm dev                        # http://localhost:5173
pnpm typecheck && pnpm lint && pnpm test
```

## Status

Phase 1 (single-tenant MVP) and the Phase 2 items that make it trustworthy are built: return-to-rep
flow, rep status notifications, retention job, audit log, simple form settings (required / optional /
hidden and the ask phrasing), unreadable-photo and unregistered-number handling. Not built, by
decision: Stripe metered billing, Sign in with Microsoft, the full conditional-rule form builder and
the printable PDF. Those wait for a paying customer to ask.
