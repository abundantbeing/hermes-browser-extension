# Setting up the Hermes Browser Extension for a user (for AI agents)

You are an AI agent, possibly Hermes itself, and a person asked you to set up the Hermes Browser Extension. Follow these steps in order.

The steps happen in two places:
- **On the machine that runs Hermes.** You can usually do these yourself.
- **In the person's browser.** Only the person can do these: Chrome does not let a program load an unpacked extension or press its buttons. Tell them exactly what to click.

Do not invent other steps. Do not ask the person to add anything to `API_SERVER_CORS_ORIGINS` unless step 5 says so.

## 1. Find out where Hermes runs and which browser they use

Ask, or check:
- Is Hermes on this same computer, in WSL, in Docker, on a VPS, on another computer, or Hermes Cloud?
- Is the browser Chrome, Edge, Brave or another Chromium browser, or Firefox?
- Do they want Hermes to operate their tabs (Hermes Control), or only chat with page context?

For Hermes Cloud, skip to the [connection guide's Hermes Cloud section](./connection-guide.md#hermes-cloud). It needs no key and no Hermes-side change.

## 2. On the Hermes machine: make sure the API server has a key

```bash
hermes config get API_SERVER_KEY
```

If it is unset or shorter than 16 characters, set one and restart the gateway:

```bash
hermes config set API_SERVER_KEY "$(openssl rand -hex 32)"
hermes gateway restart
```

- On native Windows without `openssl`, use the PowerShell lines in the [connection guide](./connection-guide.md#step-1-give-hermes-an-api-key), which turn 32 random bytes into 64 hex characters.
- `hermes config env-path` shows the `.env` file.
- Restarting the gateway briefly interrupts every bot and chat on it. **Ask the person before you restart.**

Then check the API server:

```bash
curl http://127.0.0.1:8642/health
curl -H "Authorization: Bearer <key>" http://127.0.0.1:8642/v1/models
```

- Both commands must succeed before you go on.
- To read the key back, use `hermes config get API_SERVER_KEY --raw`.
- Never paste the key into a chat log, an issue or a commit. The person will paste it into the extension.

## 3. Choose the address the browser will use

| Hermes is… | Address for the extension | What you do on the Hermes side |
| --- | --- | --- |
| On the same computer | `http://127.0.0.1:8642` | Nothing more. |
| In WSL2, browser on Windows | `http://127.0.0.1:8642` | If that fails, set `API_SERVER_HOST=0.0.0.0` in WSL's Hermes `.env`, restart, and use the WSL IP from `hostname -I`. |
| In Docker | `http://127.0.0.1:8642` | Run the container with `-e API_SERVER_HOST=0.0.0.0 -p 127.0.0.1:8642:8642`. |
| On a VPS or another computer with Tailscale | The `https://….ts.net` address `tailscale serve --bg 8642` prints | Run that command on the Hermes machine. |
| On a VPS reached over SSH | `http://127.0.0.1:18642`, as a **Local gateway** | The person runs `ssh -N -L 18642:127.0.0.1:8642 user@server` and keeps it open. |
| On another computer on the same LAN | `http://<lan-ip>:8642` | Set `API_SERVER_HOST=0.0.0.0`, allow port 8642 for the LAN only, restart. |
| Behind an HTTPS reverse proxy | `https://hermes.example.com` | Proxy to `127.0.0.1:8642` with response buffering off. See the [connection guide](./connection-guide.md#behind-an-https-reverse-proxy). |

Never bind the API server to a public interface without HTTPS in front of it.

If they want Hermes Control, the address must be `127.0.0.1` / `localhost` (Local gateway, which includes an SSH tunnel) or `https://` (Remote gateway): Hermes Control refuses a remote `http://` address. A plain LAN or tailnet IP is chat only; offer the SSH tunnel or `tailscale serve` instead.

For a named profile:
- keep the plain gateway address: do not add `/p/<profile>`, because the extension adds it when the person picks the profile in the side panel's bot list;
- use that profile's own `API_SERVER_KEY`, from `~/.hermes/profiles/<profile>/.env`.

## 4. In the browser: install and connect (the person does this)

**Chromium.** You can run these commands in the repository:

```bash
npm install
npm run build
```

Then tell the person:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the repository's `dist/` folder.
2. Open the side panel with the Hermes icon or Alt+H.
3. Finish first-time setup, and on its last step choose **Manual setup**. Do not wait on **Connect to Hermes**: stock Hermes has no pairing routes.
4. Choose **Local gateway** for a `127.0.0.1` address (an SSH tunnel included), or **Remote gateway** for anything else. Enter the address from step 3 and paste the key.
5. Click **Test connection**, then **Save settings**, then send a message.

On Windows, `Setup_Hermes_Browser_Extension.cmd --clip` builds the extension, opens the extensions page and copies the key to the clipboard; without `--clip` it copies nothing.

**Firefox.** The person installs the add-on from [AMO](https://addons.mozilla.org/firefox/addon/hermes-browser-extension/), then follows steps 2 to 5 above with Ctrl+Shift+H instead of Alt+H.

## 5. If the first message is refused with a 403

This happens on the Firefox add-on 0.4.1 and in browsers that ignore extension network rules. Current Chromium builds remove the header Hermes refuses.

1. Ask the person for the origin the panel names. It looks like `chrome-extension://<id>` or `moz-extension://<uuid>`.
2. Add it to the Hermes `.env`:

   ```bash
   API_SERVER_CORS_ORIGINS=<that origin>
   ```

3. Restart the gateway, after asking the person first.

## 6. Optional: Hermes Control

If they want Hermes to operate their tabs, install the plugin on the Hermes machine for each profile they chat with, then restart the gateway (ask first):

```bash
hermes plugins install hermes-browser-extension --enable
hermes -p <profile> plugins install hermes-browser-extension --enable
hermes gateway restart
```

Then tell the person:
1. Press **Test connection**.
2. Turn on **Settings > Permissions & Control > Hermes Control**.
3. Attach a tab.

Hermes Control clicks and types only in Chromium. Firefox has a restricted version.

## 7. Confirm

Ask the person to open a normal web page and send *"Summarize this page in one sentence."* A reply means the setup is done.

If something fails, match the message they see against [troubleshooting.md](./troubleshooting.md#cannot-connect).
