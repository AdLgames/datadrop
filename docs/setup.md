# Setup and go-live checklist

Everything here is done once per deployment. Items marked **you** need an account or a dashboard
only you can reach.

## 1. Supabase (project `accountdrop`, London)

The schema, RLS policies, the `forms` bucket and the reference counter are already applied
(`supabase/migrations` in this repo mirror them).

- [ ] **you** Project settings → API keys: copy the **service role** key into `SUPABASE_SERVICE_ROLE_KEY`.
      The publishable key is already in `.env.example`.
- [ ] **you** Authentication → Providers → Email: enabled; **Confirm email off** is fine (users only
      exist by invitation); set **OTP expiry** to 600 seconds and **OTP length** to 6.
- [ ] **you** Authentication → Email Templates → _Magic Link_: replace the body so the code is first:
      `html
    <h2>Your AccountDrop sign-in code</h2>
    <p style="font-size:28px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
    <p>Enter it at {{ .SiteURL }}/login/code. It expires in 10 minutes. If you didn't request it, ignore this email.</p>
    `
      Subject: `Your AccountDrop sign-in code`. (The app sends codes, never links, so corporate link
      scanners cannot consume them.)
- [ ] **you** Authentication → SMTP settings: custom SMTP via Resend (`smtp.resend.com`, port 465,
      user `resend`, password = your Resend API key, sender on your verified domain). Supabase's
      built-in sender is limited to a few emails an hour and is not for production.
- [ ] **you** Authentication → URL configuration: Site URL = your `APP_URL`; redirect allow-list =
      the same origin only.
- [ ] **you** Authentication → Rate limits: keep the defaults or tighten OTP requests per hour.
- [ ] Create the first tenant and its admin (SQL editor, replace the values):
      `sql
    insert into public.tenants (name, settings)
    values ('Your Company Ltd', '{"allowed_domains":["yourcompany.co.uk"],"notify_emails":["credit@yourcompany.co.uk"],"retention_days":30}')
    returning id;
    insert into public.credit_users (tenant_id, email, name, role)
    values ('<tenant id from above>', 'you@yourcompany.co.uk', 'Your Name', 'admin');
    `
      Then sign in at `/login` with that email. Add reps and other users from the app.

## 2. Twilio WhatsApp

- [ ] **you** Twilio Console → Messaging → Try it out → _Send a WhatsApp message_: note the sandbox
      number and join phrase. Each rep sends `join <phrase>` once from their phone.
- [ ] **you** Sandbox settings → _When a message comes in_: `https://<APP_URL>/webhooks/twilio`, POST.
- [ ] Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`.
- [ ] **you** Start Meta business verification now (Twilio Console → WhatsApp senders). It needs a
      legal entity, a website and a domain, and takes days to weeks. Production senders and the
      status-update templates (approved / returned / rejected / reminder) both depend on it.
- [ ] Status updates outside the 24-hour window need approved templates; until then they are sent
      as plain messages and simply fail (logged) when the window has closed.

## 3. Claude, Companies House, email

- [ ] `ANTHROPIC_API_KEY` from the Anthropic console. The default model is `claude-opus-5-5`.
- [ ] `COMPANIES_HOUSE_API_KEY`: free, from the Companies House developer hub (a "REST" key).
- [ ] `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `EMAIL_FROM` on a verified Resend domain.

## 4. Vercel

- [ ] Project root directory `apps/web`, framework React Router, Fluid Compute on (default). The
      webhook answers Twilio immediately and finishes the extraction and reply with `waitUntil`.
- [ ] Environment variables: everything in `.env.example`, with `NODE_ENV=production`,
      `APP_URL=https://<your domain>` and a random `CRON_SECRET` (32+ characters).
- [ ] `vercel.json` schedules `/api/cron/retention` daily at 02:30 UTC.

## 5. Before the first external pilot

- [ ] ICO registration (data protection fee).
- [ ] DPA and privacy notice: name Twilio/Meta (WhatsApp transport), Anthropic (extraction, no
      training on API data), Supabase (hosting, London), Resend (email).
- [ ] Decide bank-detail capture per tenant (off by default in the form settings).
- [ ] Test with two dummy tenants that neither can see the other's rows.
