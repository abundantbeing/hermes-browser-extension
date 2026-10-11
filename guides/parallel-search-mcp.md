# Parallel Search MCP

Add free web search and page fetching to your connected Hermes runtime with
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
No Parallel account or API key is needed. Anonymous search uses Fast mode;
the free endpoint has lower rate limits and caps excerpts at roughly 25,000
characters per tool call.

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
3. Merge the server from [examples/parallel-search-mcp.yaml](../examples/parallel-search-mcp.yaml)
   under the existing `mcp_servers` mapping. Keep your other servers and settings;
   do not replace the whole configuration or add a second `mcp_servers` key.

```yaml
mcp_servers:
  parallel-search:
    url: "https://search.parallel.ai/mcp"
    headers:
      User-Agent: "hermes-browser-extension/parallel-search-mcp"
    tools:
      include: [web_search, web_fetch]
```

The static `User-Agent` identifies this integration to the server. It contains
no user or profile identifier. Requests go from the Hermes machine to Parallel;
the browser extension needs no new host permission. Search queries and fetched
URLs are sent to Parallel when these tools run. Existing search-provider defaults
and browser-context consent settings remain in place.

4. From the connected Hermes profile, check the connection:

   ```bash
   hermes mcp test parallel-search
   ```

   The discovered tools should include `web_search` and `web_fetch`. Restart the
   connected Hermes gateway so it loads the updated configuration, then reconnect
   the extension using **Test connection**. For Remote API mode, perform the
   configuration and restart on the remote Hermes machine.

## Tools and troubleshooting

- `web_search` accepts an `objective` and `search_queries` and returns source
  URLs with relevant excerpts.
- `web_fetch` accepts a `urls` list and an optional `objective` and returns page excerpts.

Connection testing checks MCP discovery. It does not run a model turn or verify
which tools a model will select in a browser conversation.

If the server is missing, check that the gateway and terminal use the same Hermes
profile. If the connection fails, check outbound HTTPS access from the Hermes
machine and its MCP logs. For a rate-limit response, wait for the server's stated
retry interval; adding this example does not make free access unlimited.

To remove the integration, delete only `mcp_servers.parallel-search` from the
connected profile's configuration and restart that gateway.
