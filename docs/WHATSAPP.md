# WhatsApp Channel (Cloud API) — Operator Setup

`core/WhatsAppGateway.js` is the WhatsApp sibling of `core/Gateway.js` (Telegram).
It talks to **Meta's official WhatsApp Cloud API** over plain HTTPS, so it adds
**no npm dependency** — no headless browser, no reverse-engineered protocol.

* **Inbound** — a webhook mounted inside the existing Mission Control HTTP server.
* **Outbound** — `POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages`.

Both channels feed the same `actionExecutor.getMessageHandler()`, so the whole
agent swarm, slash commands and `!shell` escape work identically on WhatsApp.

---

## 1. Create the Meta app

1. Go to <https://developers.facebook.com/apps> and **Create App** → type
   **Business**.
2. In the app dashboard, **Add product** → **WhatsApp** → **Set up**.
   This provisions a free test phone number and a sandbox WhatsApp Business
   Account (WABA) for you.
3. Open **WhatsApp → API Setup**. This page gives you almost everything:
   * **Phone number ID** — the numeric id under the "From" phone number.
     This is `WHATSAPP_PHONE_NUMBER_ID` (it is *not* the phone number itself).
   * **WhatsApp Business Account ID** — keep it handy for support tickets.
   * **Temporary access token** — valid 24 h. Fine for a first smoke test,
     useless for a daemon. Get a permanent one (step 2).
4. Still on **API Setup**, add your own phone number under
   **To → Manage phone number list**. The test number may only message numbers
   you have explicitly verified this way.

> **Production note.** The test number is rate-limited and cannot message
> arbitrary recipients. To use your own number, add it under
> **WhatsApp → Phone numbers** and complete business verification.

## 2. Get a permanent access token

Temporary tokens expire every 24 hours. For an always-on bridge, mint a
**System User** token:

1. <https://business.facebook.com/settings/system-users> → **Add** →
   name it e.g. `telegramv4-bridge`, role **Admin**.
2. **Add Assets** → select your app → enable **Full control**.
   Also add the WhatsApp Account asset with **Full control**.
3. **Generate new token** → pick your app → set expiry **Never** → select
   scopes `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Copy the token once — it is never shown again. This is
   `WHATSAPP_ACCESS_TOKEN`.

Treat it like a password: it can send messages as your business number.
Keep it in `.env` only, never in git.

## 3. Get the app secret

**App dashboard → App settings → Basic → App Secret → Show.**
This is `WHATSAPP_APP_SECRET`. The gateway uses it to verify the
`X-Hub-Signature-256` HMAC on every inbound POST, which is what stops anyone
who learns your webhook URL from injecting messages into your agent swarm.

If it is unset the gateway still runs, but it logs a warning and accepts
unsigned payloads. **Set it in production.**

## 4. Expose the webhook publicly (HTTPS required)

Meta only calls **public HTTPS URLs with a valid certificate** on port 443.
`http://localhost:3141` will be rejected.

**On a VPS** — put the Mission Control port behind a TLS reverse proxy:

```nginx
# /etc/nginx/sites-enabled/bridge
server {
    listen 443 ssl;
    server_name bridge.example.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.example.com/privkey.pem;

    location /webhook/whatsapp {
        proxy_pass http://127.0.0.1:3141;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Certificate via `certbot --nginx -d bridge.example.com`.

**For local testing** — use a tunnel that terminates TLS for you:

```bash
cloudflared tunnel --url http://localhost:3141
# or
ngrok http 3141
```

Both print a public `https://<random>.trycloudflare.com` /
`https://<random>.ngrok-free.app` URL. Use that host below. Note the URL
changes on every restart unless you pay for a reserved subdomain, and you must
re-save the callback URL in the Meta dashboard each time.

Only `/webhook/whatsapp` needs to be public. Do **not** expose the rest of
Mission Control — it is an authenticated-by-query-token dashboard that can run
shell commands.

## 5. Register the callback URL

**App dashboard → WhatsApp → Configuration → Webhook → Edit.**

| Field | Value |
| --- | --- |
| Callback URL | `https://bridge.example.com/webhook/whatsapp` |
| Verify token | any random string you invent — put the same value in `WHATSAPP_VERIFY_TOKEN` |

Generate a verify token with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Start the bridge **before** clicking **Verify and save**. Meta immediately sends
a `GET` with `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`; the
gateway echoes the challenge back when the token matches (and returns `403`
when it does not). You should see:

```
[WhatsApp] Webhook verification succeeded.
```

Then click **Manage** next to *Webhook fields* and subscribe to **`messages`**.
Without that subscription the handshake succeeds but no messages ever arrive.

## 6. Environment variables

Add to `.env`:

```dotenv
# --- WhatsApp Cloud API ---
WHATSAPP_ACCESS_TOKEN=EAAG...permanent-system-user-token
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=3f9c1a...whatever-you-invented
WHATSAPP_APP_SECRET=abcdef0123456789abcdef0123456789
WHATSAPP_ALLOWED_NUMBERS=+1 555-0100,+44 7700 900123

# optional
WHATSAPP_WEBHOOK_PATH=/webhook/whatsapp
WHATSAPP_API_VERSION=v21.0
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | to send | Bearer token for Graph API calls |
| `WHATSAPP_PHONE_NUMBER_ID` | to send | numeric id of the sending number |
| `WHATSAPP_VERIFY_TOKEN` | to receive | shared secret for the `hub.challenge` handshake |
| `WHATSAPP_APP_SECRET` | strongly recommended | verifies `X-Hub-Signature-256` on inbound POSTs |
| `WHATSAPP_ALLOWED_NUMBERS` | strongly recommended | comma-separated allow-list; **empty means everyone** |
| `WHATSAPP_WEBHOOK_PATH` | no | defaults to `/webhook/whatsapp` |
| `WHATSAPP_API_VERSION` | no | defaults to `v21.0` |

`WHATSAPP_ALLOWED_NUMBERS` is separated by commas, semicolons or newlines —
**not** spaces, so `+1 555-0100` stays one entry. Both sides are normalised to
digits before comparison, so `+1 555-0100`, `+1 (555) 0100` and `15550100` are
the same number. This mirrors Telegram's `ALLOWED_USER_ID` gate: anything not
on the list is logged and dropped. Leaving it empty also disables the `!shell`
escape, exactly like a missing `ALLOWED_USER_ID` does on Telegram.

If none of the WhatsApp variables are set, the bridge boots normally with the
channel disabled — same tolerance as a missing `TELEGRAM_BOT_TOKEN`.

## 7. Test send

Messages can only be sent to a number that has messaged you in the last 24 h
(the "customer service window"), or via a pre-approved template. For a first
test, send yourself a WhatsApp from the allow-listed phone, then:

```bash
curl -X POST "https://graph.facebook.com/v21.0/$WHATSAPP_PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "15550100",
    "type": "text",
    "text": { "preview_url": false, "body": "Hello from TelegramV4 " }
  }'
```

`to` must be digits only, with country code, no `+`.

Outside the 24 h window use the pre-approved `hello_world` template instead:

```bash
curl -X POST "https://graph.facebook.com/v21.0/$WHATSAPP_PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "15550100",
    "type": "template",
    "template": { "name": "hello_world", "language": { "code": "en_US" } }
  }'
```

Verify the webhook handshake by hand:

```bash
curl -i "https://bridge.example.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=12345"
# → HTTP/1.1 200 OK
# → 12345
```

## 8. Behaviour notes

* **Chunking** — outbound text is split to WhatsApp's 4096-character body
  limit, preferring newline boundaries, one Cloud API call per chunk.
* **Idempotency** — Meta retries any webhook it does not get a fast `200` for.
  The gateway acknowledges immediately and de-duplicates by message `id` in a
  bounded 1000-entry cache, so a retried delivery never runs the agent twice.
* **No message editing** — WhatsApp cannot edit a sent message, so the
  "⏳ Thinking…" placeholder that Telegram edits in place is simply not used;
  the final answer arrives as one or more new messages.
* **No inline keyboards** — Telegram's callback buttons have no WhatsApp
  equivalent here. Use the slash commands (`/new`, `/status`, `/agent`,
  `/model <name>`, `/help`, …) which map to the same system actions.
* **Media** — inbound images, documents and voice notes are downloaded into
  `uploads/` and referenced to the agent exactly the way the Telegram gateway
  does. Outbound media is sent by public URL (`link`), not by upload.

## 9. Troubleshooting

| Symptom | Cause |
| --- | --- |
| "The callback URL or verify token couldn't be validated" | bridge not running, path wrong, tunnel down, or `WHATSAPP_VERIFY_TOKEN` mismatch |
| Handshake OK but no messages arrive | you did not subscribe to the **`messages`** webhook field |
| `[WhatsApp] Rejected webhook payload: invalid X-Hub-Signature-256` | `WHATSAPP_APP_SECRET` is wrong, or a proxy is rewriting the body (the HMAC is over the raw bytes) |
| `[WhatsApp] Blocked message from non-allow-listed number` | add the number to `WHATSAPP_ALLOWED_NUMBERS` |
| `(#131030) Recipient phone number not in allowed list` | Meta-side test-number restriction — add the recipient under **API Setup → Manage phone number list** |
| `(#131047) Re-engagement message` | the 24 h customer service window has closed; the user must message first |
| Token stops working after a day | you are using the temporary token; mint a System User token (step 2) |
