# Keenable Search MCP

Add free web search and page fetching to your connected Hermes runtime with
[Keenable Search MCP](https://docs.keenable.ai/mcp-server).
No Keenable account or API key is needed. The keyless endpoint is rate limited
per IP address; an optional API key lifts those limits.

This is an optional Hermes configuration example for **Local** and **Remote API**
connections. The extension uses the MCP tools configured in that runtime.
Hermes Cloud and remote dashboard-ticket connections are chat-only in this release.
See the [connection guide](connection-guide.md) for connection setup.

## Configure the connected runtime

1. Use a working [Hermes Agent installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
   with its supported [HTTP MCP client](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).
   The standard Hermes installation includes MCP support.
2. On the machine running Hermes, open the connected profile's `config.yaml`.
   The default is `~/.hermes/config.yaml` on Unix or `%LOCALAPPDATA%\hermes\config.yaml`
   on Windows. If you use `HERMES_HOME` or a named profile, edit that profile's
   configuration instead.
3. Merge the server from [examples/keenable-search-mcp.yaml](../examples/keenable-search-mcp.yaml)
   under the existing `mcp_servers` mapping. Keep your other servers and settings;
   do not replace the whole configuration or add a second `mcp_servers` key.

```yaml
mcp_servers:
  keenable-search:
    url: "https://api.keenable.ai/mcp-public"
    headers:
      X-Keenable-Title: "hermes-browser-extension"
    tools:
      include: [search_web_pages, fetch_page_content]
```

The static `X-Keenable-Title` header names this integration to the server, and the
keyless endpoint requires it. It contains no user or profile identifier. Requests
go from the Hermes machine to Keenable; the browser extension needs no new host
permission. Search queries and fetched URLs are sent to Keenable when these tools
run. Existing search-provider defaults and browser-context consent settings remain
in place.

4. From the connected Hermes profile, check the connection:

   ```bash
   hermes mcp test keenable-search
   ```

   The discovered tools should include `search_web_pages` and `fetch_page_content`.
   Restart the connected Hermes gateway so it loads the updated configuration, then
   reconnect the extension using **Test connection**. For Remote API mode, perform
   the configuration and restart on the remote Hermes machine.

## Optional API key

To lift the keyless rate limits, put `KEENABLE_API_KEY=<your key>` in the connected
profile's `.env` and add one header to the server entry:

```yaml
    headers:
      X-Keenable-Title: "hermes-browser-extension"
      X-API-Key: "${KEENABLE_API_KEY}"
```

Leave this header out when you have no key: Hermes refuses to connect a remote
server whose header names a variable that is not set.

## Tools and troubleshooting

- `search_web_pages` accepts a `query` and optional `site`, `published_after`,
  `published_before` and `max_results` and returns source URLs with page text snippets.
- `fetch_page_content` accepts a `url` and returns the page as markdown.

Connection testing checks MCP discovery. It does not run a model turn or verify
which tools a model will select in a browser conversation.

If the server is missing, check that the gateway and terminal use the same Hermes
profile. If the connection fails, check outbound HTTPS access from the Hermes
machine and its MCP logs. For a rate-limit response, wait for the server's stated
retry interval; adding this example does not make free access unlimited.

To remove the integration, delete only `mcp_servers.keenable-search` from the
connected profile's configuration and restart that gateway.
