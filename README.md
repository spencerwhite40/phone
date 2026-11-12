# Haulers Phone

A multi-tenant phone system as an installable web app (PWA): keypad, calls, SMS, voicemail,
and voicemail greetings you record or upload in the browser. One link, add to home screen,
works the same on phone and desktop.

It is a standalone app with its own
`package.json` and database tables, separate from Hauler Fuel.

## What v1 does

| | Twilio | Bird |
|---|---|---|
| Outbound calls (from the keypad, caller ID = the number you pick) | Yes | No (see below) |
| Inbound calls ring the app, plus an optional cell phone at the same time | Yes | No |
| Voicemail (record, listen, call back, text back) | Yes | No |
| Voicemail greeting per number (record in browser or upload any audio) | Yes | No |
| SMS send and receive, threads, unread badges | Yes | Yes |

## Businesses, people and numbers

One operator login runs many businesses. The first account created on a fresh install is the **operator**:
it can open every business, create new ones, and assign numbers to them. You connect your own Twilio and Bird
accounts once, then give each business the numbers it should have.

| Role | Can do |
|---|---|
| Operator | Everything, in every business: create businesses, move numbers between them, manage providers |
| Owner | Run one business: providers, people, every number in it |
| Admin | Add people, assign them to numbers, change number settings (not roles or providers) |
| Member | Only the numbers assigned to them: calls, texts, voicemail, and their own voicemail greetings |

- **Routing:** inbound calls to a number ring the people assigned to it, all at once or one at a time in the order you set.
  A number nobody is assigned to rings the owners and admins, so a call is never dropped. An optional cell number rings too.
- **Greetings:** anyone assigned to a number can record or upload its voicemail greeting right on that number's card.
- **People in several businesses:** adding someone who already has a login attaches them to the new business. They keep one
  password and switch businesses from the top bar.
- **Moving a number** to another business takes its texts, calls and voicemail with it, and clears who was assigned.

**Bird calls are not in v1.** Bird's voice product is SIP-trunk based and has no browser calling.
The practical route is to point a Bird number's SIP trunk at Twilio, after which it is a Twilio number
here. Bird texting works fully.

**Ringing only happens while the app is open.** Browsers cannot wake a closed web app for a call.
Set "Also ring my cell" on a number so calls reach you when the app is closed. Voicemail and texts
are unaffected.

## Run it

```bash
# (from the repo root)
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/phone
export APP_SECRET=$(openssl rand -hex 32)      # encrypts provider credentials + signs sessions; keep it stable
export PUBLIC_URL=https://phone.example.com     # the public https address Twilio/Bird will call
npm start
```

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres 13+. Tables are created on boot. |
| `APP_SECRET` | yes | 16+ chars. Changing it makes stored provider credentials unreadable. |
| `PUBLIC_URL` | for webhooks | Exact public origin, no trailing slash. Twilio signatures are checked against it. |
| `SIGNUP_CODE` | no | If set, creating a company requires this code. Set it on any public deployment. |
| `PORT` | no | Default 3100. |

## Deploy (Render)

New Web Service from this repo: leave Root Directory blank, Build `npm install`, Start `npm start`,
plus a Postgres database and the env vars above. Use the generated `https://…onrender.com` URL (or a custom domain) as `PUBLIC_URL`.

## Connect your numbers

1. Open the app, **Create a company** (the first account becomes the operator), then go to **Settings → Providers**.
2. **Twilio:** paste the Account SID and Auth Token. The app creates an API key and a calling app,
   imports every number on the account, and points each number's voice and SMS webhooks at itself. Use **Sync** later to pick up new numbers.
3. **Bird:** paste an access key (Application Developer role), workspace ID, SMS channel ID and the channel's number,
   then copy the webhook URL shown into Bird so inbound texts arrive.
4. **Settings → Businesses:** create each business and assign numbers to it. **People:** add staff and tick their numbers.
5. **Settings → Numbers:** set the ring order and record or upload each number's voicemail greeting.

Add to home screen: iPhone Share → Add to Home Screen; Android ⋮ → Install app; desktop: the install icon in the address bar.

## Tests

```bash
npm test                                                     # unit tests (no database needed)
PHONE_TEST_DATABASE_URL=postgres://… npm test                # also runs the call/SMS/voicemail/tenant-isolation flow tests
```

Use a throwaway database for the flow tests: they `TRUNCATE` the tables.

## Layout

```
server.js            boot
src/app.js           express setup, sessions, CSRF header check
src/api.js           JSON API (auth, team, connections, numbers, greetings, messages, voicemail)
src/hooks.js         provider webhooks (Twilio voice/SMS, Bird SMS) + public greeting audio
src/providers/       twilio.js (REST, JWT, signature), bird.js
src/db.js            schema (one multi-statement query)
public/              the PWA: app.js, wav.js (recorder/converter), sw.js, manifest, icons
```

## Security notes

- Provider credentials are AES-256-GCM encrypted in the database and never returned by the API.
- Every Twilio webhook is verified against that number's own account token; Bird webhooks use a per-connection secret in the URL.
- State-changing API calls require an `X-Requested-With` header (blocks cross-site form posts); sessions are HttpOnly, SameSite=Lax cookies.
- Greeting audio is served from an unguessable UUID URL so Twilio can fetch it; voicemail recordings are proxied behind sign-in.
