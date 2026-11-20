# PB FPS Online — Deno port (for Deno Deploy, free tier)

Deno port of `~/workspace/pb-fps-render/server.js` (Node.js + `ws`).
**Protocol is byte-identical to PROTOCOL.md v1** — the browser client
(`public/client.js`, copied unchanged) works against this server with zero
changes: same WebSocket message types, same room codes, same damage/bots.

## What changed vs the Node version (platform APIs only)

- `http.createServer` + `ws` server → `Deno.serve` + native
  `Deno.upgradeWebSocket` (WebSocket upgrade accepted on any path, same as
  the Node `ws` server; the client connects to `ws(s)://<host>/`).
- `crypto.randomBytes` → `crypto.getRandomValues` (player-id hex).
- `fs.readFile` / `path` → `Deno.readFile` with a path resolved from
  `import.meta.url` (works on Deno Deploy: files in the repo are readable).
- `process.env.PORT` → `Deno.env.get("PORT")`, default **8000** (the port
  Deno Deploy expects).
- `setTimeout` handle type is `ReturnType<typeof setTimeout>` (Deno 2).
- All game logic is untouched: map obstacles (mulberry32), hit validation,
  bot AI incl. the 0.7–1.4 s per-bot shot cooldown, TDM/FFA, chat relay,
  voice-signal relay, match timer, respawn, room cleanup.
- `main.ts` is guarded by `if (import.meta.main)` so it can be imported
  by the test without starting the server.

## Files

| File | What it is |
|---|---|
| `main.ts` | Deno server (HTTP static + WebSocket), entrypoint for Deno Deploy |
| `deno.json` | Tasks: `deno task start`, `deno task test` |
| `public/` | Client copied unchanged from the Node version (index.html, client.js, style.css) |
| `test-integration.ts` | Integration test (local only, NOT pushed to the deploy repo) |

## Local run

```sh
deno task start          # serves on http://localhost:8000 (or $PORT)
deno task test           # full integration test (20 checks, ~30 s)
```

## Verification (done 21 Nov 2026, Deno 2.9.8)

- `deno check main.ts test-integration.ts` — clean.
- Integration test **20/20 PASS**: obstacle counts identical to Node for all
  6 maps (Downtown 26, Luxville 26, Midtown 25, Burning Hall 23,
  Safe House 24, Crackdown 24); HTTP 200 for `/`, `/client.js`, `/style.css`;
  room create/join, voice-signal relay, chat relay, match start, bots filled
  to 14 (8v8), stationary player survived 20 s of bot fire, human shooting
  a bot registers hits (dmg 34), FFA room + 7 bots.
- Smoke test on default port 8000: `GET /` 200, `GET /client.js` 200,
  WebSocket upgrade 101.

## Deploy to Deno Deploy (browser steps — subagent cannot use a browser)

Deno Deploy free tier, **no card required**. Steps for the parent agent:

1. **GitHub repo** (browser): create public repo `pb-fps-online-deno`
   under `hendraaragaki` (no README init). Then push from this directory:
   ```
   /opt/hatch/bin/github push-files --owner hendraaragaki --repo pb-fps-online-deno \
     --branch main --message "PB FPS Online — Deno port for Deno Deploy" \
     --source-dir /home/hatch/workspace/pb-fps-deno --paths-file <manifest>
   ```
   Manifest (NUL-delimited, 6 files): `main.ts`, `deno.json`, `README.md`,
   `public/index.html`, `public/client.js`, `public/style.css`.
   (Do NOT include `test-integration.ts`.) Append the confirmed commit SHA to
   `~/workspace/pb-fps-deno.muse-github-snapshot-sync.json` per the
   snapshot-push procedure.
2. **Deno Deploy account** (browser): open https://dash.deno.com, sign in
   with GitHub (`hendraaragaki`) — Hendra approves the OAuth himself.
   Free plan, no payment method.
3. **New Project** (browser): connect the `pb-fps-online-deno` repo,
   entrypoint `main.ts`, deploy. Public URL will be
   `https://pb-fps-online-deno.deno.dev` (project name sets the subdomain).
4. **Verify**: open the URL, confirm the menu loads and a room can be
   created. Deno Deploy serves over HTTPS, so the client uses `wss://`
   automatically (`location.host` + protocol check — no hard-coded host).

## Known limitations

- Deno Deploy free tier: usage limits apply (generous for a friends test);
  the deployment sleeps/cold-starts after idle like other free tiers.
- Voice chat: WebRTC with Google STUN only, no TURN — voice may fail
  between players behind symmetric NATs (same as the Node version).
- Not visually verified in a real browser — verified by type check, HTTP
  serving, protocol tests and deterministic-map comparison. First real
  playtest should be on the deployed URL.
