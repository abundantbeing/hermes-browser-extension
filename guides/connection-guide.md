# Connection guide

Everything you need to connect the Hermes Browser Extension to your Hermes, wherever that Hermes runs. If you only want the fastest path for Hermes on the same computer, the [README Quick start](../README.md#quick-start) is enough.

## How a connection works

The extension talks to the **Hermes API server**, the HTTP API that Hermes' gateway serves. It needs two things:

1. **An address the browser can reach.** On the same computer this is `http://127.0.0.1:8642`.
2. **The API server key**, `API_SERVER_KEY` from the Hermes `.env`.

Hermes turns the API server on as soon as `API_SERVER_KEY` is set, and it refuses to start the API server without a key of at least 16 characters. That is true on `127.0.0.1` too. A missing or short key is the most common reason nothing answers.

You do **not** need to add the extension to `API_SERVER_CORS_ORIGINS` any more:
- The extension removes the `Origin` header from its own API requests to the gateway you connected, which is the header Hermes refuses unless it is listed.
- Builds from source after this change do this, and so will the next release.
- The Firefox add-on 0.4.1 and browsers that ignore extension network rules (see [If a message is refused with a 403](#if-a-message-is-refused-with-a-403)) still need the line.
- When the panel sees that refusal, it names the exact line to add.

Two things that are **not** needed on stock Hermes:
- **Connect to Hermes / automatic pairing.** It needs pairing routes that current Hermes does not ship. On stock Hermes it ends in "Automatic pairing isn't available", so use **Manual setup** or **Settings > Connections > Add** with the address and key.
- **The Hermes plugin, for chat.** Chat, page context, sessions, models and attachments work without it. The plugin adds Hermes Control (Hermes operating your tabs) and Background task tabs. See [Add Hermes Control](#add-hermes-control-the-plugin).

## Step 1: give Hermes an API key

Do this on the machine that runs Hermes.

1. Make a key of 32 or more random characters:

   ```bash
   # macOS, Linux, WSL
   openssl rand -hex 32
   ```

   ```powershell
   # Windows PowerShell: 32 random bytes as 64 hex characters
   $bytes = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   -join ($bytes | ForEach-Object { $_.ToString('x2') })
   ```

2. Save it in Hermes:

   ```bash
   hermes config set API_SERVER_KEY <the-key>
   ```

   Or add `API_SERVER_KEY=<the-key>` to the Hermes `.env` yourself. `hermes config env-path` prints where that file is:
   - `~/.hermes/.env` on macOS, Linux and WSL;
   - `%LOCALAPPDATA%\hermes\.env` on a new native Windows install (older installs use `%USERPROFILE%\.hermes\.env`);
   - `$HERMES_HOME/.env` if you moved the data folder.

3. Restart the gateway so it picks the key up:

   ```bash
   hermes gateway restart      # Hermes runs as a service
   hermes gateway run          # or run it in the foreground
   ```

4. Check it from the same machine:

   ```bash
   curl http://127.0.0.1:8642/health
   curl -H "Authorization: Bearer <the-key>" http://127.0.0.1:8642/v1/models
   ```

   The first command should print a small JSON status. The second should list at least one model.

On Windows, `Copy_Hermes_Browser_API_Key.cmd` in this repository copies the key from your Hermes `.env` to the clipboard.

## Step 2: connect the extension

1. Open the side panel (the Hermes icon, Alt+H on Chromium, Ctrl+Shift+H for the Firefox sidebar).
2. On first run, finish setup and choose **Manual setup** on the last step. Later, use **Settings > Connections > Add**.
3. Pick where Hermes is, enter the address and paste the key:

   | Hermes is… | Choose | Address |
   | --- | --- | --- |
   | On this computer (including WSL2 and Docker with a published port) | This computer / **Local gateway** | `http://127.0.0.1:8642` |
   | On another computer, through an SSH tunnel | **Local gateway** | `http://127.0.0.1:<tunnel port>` |
   | On another computer, through Tailscale, a VPN or your LAN | **Remote gateway** with the key | The address from the matching section below |
   | Behind your own HTTPS reverse proxy | **Remote gateway** with the key | `https://hermes.example.com` |
   | Hermes Cloud | **Hermes Cloud** | No address. Open your signed-in Cloud agent tab first. |

4. Press **Test connection**, then send a message.

**Settings > Connections** keeps several connections, so you can switch between, say, Hermes on this computer and Hermes on a VPS. Each keeps its own address, key and options in this browser only.

**Planning to use Hermes Control?** It runs only on a gateway at a `127.0.0.1` / `localhost` address (**Local gateway**) or at an `https://` address (**Remote gateway**). Chat works over plain `http://` to another machine, but Hermes Control refuses it, because its control connection must not cross a network unencrypted. The recipes below say which kind of address each one gives you: an SSH tunnel and `tailscale serve` both work with Hermes Control, a plain LAN or tailnet IP address is chat only.

## Where is your Hermes?

### On this computer

Use `http://127.0.0.1:8642` (or the `API_SERVER_PORT` you set). The API server listens on `127.0.0.1` by default, which is the safest choice. Nothing else is needed.

### In WSL2, with the browser on Windows

WSL2 forwards `localhost` to Windows by default, so `http://127.0.0.1:8642` usually works from the Windows browser.

If it does not, your WSL networking mode does not forward `localhost`:
1. Set `API_SERVER_HOST=0.0.0.0` in the Hermes `.env` inside WSL and restart the gateway.
2. Find WSL's address with `hostname -I`, run inside WSL.
3. Connect to `http://<that-address>:8642` as a Remote gateway.

Keep the Windows firewall closed to other machines.

### In Docker

Bind the API server to every interface **inside** the container, and publish the port only on the host's loopback:

```bash
docker run ... \
  -e API_SERVER_KEY=<the-key> \
  -e API_SERVER_HOST=0.0.0.0 \
  -p 127.0.0.1:8642:8642 \
  <your-hermes-image>
```

Then connect to `http://127.0.0.1:8642`. Publishing `-p 8642:8642` without `127.0.0.1:` exposes the API server to your network.

### On a VPS or another computer, over Tailscale (recommended for remote)

Keep the API server on loopback on the Hermes machine and let Tailscale give it a private HTTPS address:

```bash
# on the Hermes machine
tailscale serve --bg 8642
```

Tailscale prints an address like `https://hermes-box.tail1234.ts.net`. Add a **Remote gateway** with that address and the key. It is HTTPS, so Hermes Control works over it.

Without `tailscale serve`, you can instead:
1. Set `API_SERVER_HOST` to the machine's Tailscale IP (`100.x.y.z`).
2. Restart the gateway.
3. Connect to `http://100.x.y.z:8642`.

The API server is then reachable only inside your tailnet. That address is plain HTTP, so it is chat only: use `tailscale serve` for Hermes Control.

### On a VPS or another computer, over an SSH tunnel

Keep the API server on loopback on the server and forward a local port to it. Use a local port that your own Hermes does not use:

```bash
ssh -N -L 18642:127.0.0.1:8642 user@your-server
```

While that command runs, add a **Local gateway** (this computer) at `http://127.0.0.1:18642` with the server's key: to the browser the tunnel is a port on this computer, which is also what lets Hermes Control use it. The extension cannot open the tunnel itself: start it before you connect, and keep it running. A tool like `autossh` or a system service keeps it up.

### On another computer on your home or office network

1. On the Hermes machine, set `API_SERVER_HOST=0.0.0.0` (or that machine's LAN address) and restart the gateway.
2. Allow port 8642 through that machine's firewall for your local network only.
3. Add a **Remote gateway** at `http://<lan-address>:8642`, for example `http://192.168.1.50:8642`.

Plain HTTP is fine for chat on a network you trust, but Hermes Control needs a loopback or HTTPS address: for it, use an SSH tunnel to that computer (and connect to the tunnel as this computer) or put HTTPS in front. Do not forward port 8642 on your router.

### Behind an HTTPS reverse proxy

Point the proxy at `http://127.0.0.1:8642` and keep the API server on loopback. Replies stream as server-sent events, so turn response buffering off and allow long requests.

Caddy (streams by default):

```caddyfile
hermes.example.com {
  reverse_proxy 127.0.0.1:8642
}
```

nginx (the `map` goes in the `http` block; the `Upgrade` and `Connection` lines carry Hermes Control's WebSocket):

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  # listen 443 ssl; server_name hermes.example.com; ssl_certificate ...;
  location / {
    proxy_pass http://127.0.0.1:8642;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
```

Add a **Remote gateway** at `https://hermes.example.com` with the key. If the proxy asks for its own sign-in header (for example Cloudflare Access service tokens), add those under **Options > Custom headers** for that connection.

If the proxy uses a certificate your browser does not trust yet, Add connection offers to open the address in a tab so you can accept it. Do **not** expose the API server to the internet without HTTPS and the key. It runs the real Hermes, with its tools.

### Several Hermes bots (named profiles)

One gateway serves every profile at one address. Hermes answers a named profile under `/p/<profile>/` on that address, and the extension adds that part itself when you pick the profile:

- Connect to the gateway's plain address, for example `http://127.0.0.1:8642`. Do not add `/p/<profile>` to the address: the extension would add it a second time.
- Pick the profile in the side panel's bot list.

Each named profile needs its own `API_SERVER_KEY` in `~/.hermes/profiles/<profile>/.env`, and the default profile's key does not work for it.

### Hermes Cloud

Hermes Cloud uses **Trusted Dashboard Attach**:

1. Open your Hermes Cloud agent in a normal browser tab and sign in.
2. Keep that fully loaded HTTPS agent tab active.
3. In Settings, choose **Hermes Cloud**.
4. Click **Connect to Hermes** or **Test connection**.

The extension binds trust to that exact active tab and HTTPS origin, and verifies the tab again before minting. It mints a short-lived, single-use WebSocket ticket in the page, then verifies the WebSocket handshake before reporting success. The ticket is kept in memory only and is never stored or logged. Cloud never falls back to localhost or to a stored Local API key.

Hermes Cloud is **chat-only** in this release:
- Browser page text, selected text, open-tab context and attachments are disabled for this mode.
- The extension does not read dashboard cookies, store a Cloud password, or add `cookies` or `nativeMessaging` permissions.

If the connected Cloud agent does not expose `/api/auth/ws-ticket`, `/api/ws` or the required session and model RPC methods:
- The extension reports the missing capability and leaves Local and Remote settings untouched.
- Update that agent's Hermes runtime using the [official Hermes Agent installation and update docs](https://hermes-agent.nousresearch.com/docs/getting-started/installation).
- The extension never redirects Cloud to `127.0.0.1` as a fallback.

### A self-hosted dashboard, without the API server

If you run Hermes elsewhere and only expose its sign-in-protected dashboard (`hermes dashboard`), select **Remote gateway**, enter the dashboard's `https://` address and leave the key blank. With no key, the extension connects over the dashboard's `/api/ws` socket instead of the REST API server. This remains a Remote gateway connection; it is not relabeled as Hermes Cloud.

Sign-in uses a single-use WebSocket ticket minted from a signed-in dashboard tab:
- Open the dashboard address in a normal browser tab, sign in, and keep that tab open.
- The extension mints the ticket first-party from that tab, then opens the socket.
- **Test connection** opens the socket and loads models, which confirms the whole path.

Limits in this mode:
- The skills and profiles lists are unavailable, because those routes are REST-only and the dashboard's REST routes are not reachable cross-origin.
- Image handling depends on what the gateway accepts over the socket. See the capability rows in Settings > About & Diagnostics.
- Projects, moving a session and Compact context work here only if the gateway reports session authority. This combination has not been exercised against a live gateway.

A remote connection never looks for, or talks to, a Hermes Dashboard on this computer, even if one is running.

## Add Hermes Control (the plugin)

Hermes Control lets Hermes operate tabs you attach. On current Hermes it comes from the extension's Hermes plugin. Install it on the machine that runs Hermes, for each profile you chat with, then restart the gateway:

```bash
hermes plugins install hermes-browser-extension --enable
hermes -p <profile> plugins install hermes-browser-extension --enable   # a named profile
hermes gateway restart
```

The name installs the version pinned in the Hermes plugin catalog. To get the newest version from this repository, for example for Background task tabs, which need plugin 0.4.1, install it from the repository URL:

```bash
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable --force
```

Then press **Test connection** and turn Hermes Control on under **Settings > Permissions & Control**. Settings > About & Diagnostics shows whether the plugin is loaded. [companion-plugin/install.md](../companion-plugin/install.md) has the details.

## If a message is refused with a 403

The extension removes `Origin` with a browser network rule. A browser that ignores extension network rules, and the Firefox add-on 0.4.1, still send it, and then Hermes refuses with a bare 403. The panel says so and names the line to add. To fix it by hand:

1. Copy the extension's origin. **Settings > Support diagnostics > Copy Diagnostics** includes it as **Extension origin**.
   - It looks like `chrome-extension://<id>` on Chromium.
   - On Firefox it is `moz-extension://<uuid>`. Firefox assigns a new UUID when the add-on is reinstalled.
2. Add it to the Hermes `.env`, comma-separated if you have several:

   ```bash
   API_SERVER_CORS_ORIGINS=chrome-extension://<id>
   ```

3. Restart the gateway.

An unpacked build's id comes from its folder path, so it changes if you move the folder.

## Compatibility matrix

| Surface | Supported in v0.4.1 | Fallback / note |
| --- | --- | --- |
| Chrome / Edge / Chromium 116+ side panel | Yes | Primary public support target. |
| Brave / Comet / Chromium forks | Best-effort | Must expose the Chromium Side Panel API. |
| Firefox | Install from [AMO](https://addons.mozilla.org/firefox/addon/hermes-browser-extension/) (Firefox 142+) | Chat and context in a sidebar declared with `sidebar_action`, plus a restricted Hermes Control (read, navigate, scroll, screenshots you allow, tabs). The Firefox package omits the `debugger`, `offscreen` and `sidePanel` permissions, so there is no trusted input (no clicks or typing) and no control of controls inside frames. Every row and its reason: [firefox.md](./firefox.md). |
| Safari | Not shipped | No Safari package is included. |
| Local Hermes API server | Yes | Default path: `http://127.0.0.1:8642`, with `API_SERVER_KEY`. |
| Hermes Cloud | Yes, Trusted Dashboard Attach | Requires an active signed-in HTTPS Hermes Cloud agent tab. Chat-only. |
| Remote API server | Yes, explicit address and key | Use Tailscale, an SSH tunnel, a trusted LAN or VPN, or an HTTPS reverse proxy; do not expose Hermes naked to the internet. |
| Self-hosted remote dashboard WebSocket | Best-effort | Select Remote gateway with an HTTPS dashboard address and no API key. Chat, session and model path only. |
| Automatic pairing (Connect to Hermes) | Needs pairing routes | Stock Hermes does not ship them. Use Manual setup with the address and key. |
| Full-page Hermes Web view | Retired | The side panel is the supported browser surface. |
| Browser Context Protocol | Yes | Typed `hermes.browser.turn.v2` envelopes, with the v1 payload compatibility path. |
| Hermes Assist | Yes, site-aware preview/review | 31 writing environments. Never submits. |
| Page comments | Yes | Attach menu. Queues beside Ask Hermes. |
| Hermes Control | Yes (Experimental) | Opt-in MV3 controller that acts only on tabs you attach, with explicit approval gates. Needs the extension's Hermes plugin on current Hermes. Reaches controls in same-site frames of an attached page; frames from other sites are not read or acted on. Restricted on Firefox: see [firefox.md](./firefox.md). |
| Projects, move a session, Compact context | Needs session authority | Needs the dashboard WebSocket and a gateway whose `gateway.ready` reports session authority. A REST-only connection, an older gateway or one that answers "method not found" gets a plain reason instead, and Recents and the older compaction keep working. Checked against a test gateway, not yet a released Hermes. |
| Capability states | Yes | Settings > About & Diagnostics lists what this connection can do, with state, reason, source and age. A feature the gateway does not advertise reads "Not advertised by this gateway". |
| `nativeMessaging` | No | Not requested or required. |

Something not working? [troubleshooting.md](./troubleshooting.md#cannot-connect) lists each connection message and what to do about it.
