# Hermes Adaptive UI (HAUI) v1

HAUI is the protocol behind the **Vivid UI** response style. A reply stays
ordinary Markdown. When structure makes an answer clearer, the model may add a
fenced block labelled `hermes-ui` that holds one JSON envelope. The extension
validates the envelope and draws native components. Anything it can't
validate shows as the original Markdown, so a reply is always readable.

Code: `extension/lib/adaptive-ui.mjs` (parser, validator, renderer, action
dispatcher), `extension/lib/adaptive-ui.css` (styles), and
`renderResponseSafe()` in `extension/lib/sanitizer.mjs`, which runs DOMPurify
over the output. The side panel and the full tab both use these modules.
Tests: `tests/adaptive-ui.test.mjs`.

## Envelope

````markdown
```hermes-ui
{"schema":"hermes.adaptive-ui","version":1,"blocks":[ ... ]}
```
````

| Field | Rule |
| --- | --- |
| `schema` | `"hermes.adaptive-ui"`. May be left out; any other value rejects the envelope. |
| `version` | The number `1`. Anything else rejects the envelope. |
| `blocks` | A non-empty array, shown in order. At most 16 blocks are drawn. |

Every block has a `type` from the allowlist below and an `id`
(`[A-Za-z0-9_.:-]{1,64}`). A missing or invalid id becomes `b<index>`, and a
repeated id gets `-<index>` added. A block may also carry `fallback` (Markdown);
if its type is unknown or its props are invalid, the fallback text is shown
in its place. Without a fallback, the block's own words are shown as text
under a short "Shown as text" note. An envelope with no usable block is shown
the same way as a whole.

Common slips are repaired before a fence is given up on: the fence spelled
`hermes_ui`, `hermesui` or `haui`; a ```` ```json ```` fence whose body names the
HAUI schema; curly quotes and trailing commas; a bare array of blocks or a
single block; a missing or quoted `version` 1. Any other version is rejected.

## Block types

| Type | Props |
| --- | --- |
| `stat` | `label`, `value` (text or number), optional `delta`, `trend` (`up`/`down`/`flat`), `caption`. Neighbouring stats share one grid of metric cards. |
| `comparison` | Optional `title`; `items`: 2 to 6 of `{title, subtitle?, points: [text], highlight?: true}`. |
| `key_value` | Optional `title`; `items`: up to 20 of `{key, value}`. |
| `table` | Optional `title`; `columns`: up to 8 texts; `rows`: up to 50 arrays (cells are text or numbers; short rows are padded). Numeric columns align right. |
| `chart` | Optional `title`, `kind` (`bar` or `line`), `labels` (1 to 24 texts), `series` (1 to 4 of `{name, values}`, one finite number or `null` per label), optional `unit`. Any other value rejects the block. Drawn as native SVG with a Chart/Table toggle; the table view holds the same numbers. |
| `list` | Optional `title`; `items`: 1 to 12 texts, or `{text, meta?}` where `meta` is a short tag such as a timestamp; optional `ordered: true`. For summaries, takeaways and steps. |
| `notice` | `tone` (`info`, `warning`, `error` or `success`; default `info`), `title`, optional `body`. For missing sources or transcripts and failed tools. |
| `disclosure` | `title`, `body` (Markdown) and/or `blocks` (nested, at most two levels). Closed by default. |
| `actions` | `items`: up to 6 of `{label, action, value}` (see below). Invalid items are dropped. |

## Actions

Actions go through a typed dispatcher with an explicit allowlist:

| Action | Effect |
| --- | --- |
| `open_url` | An `http`/`https` URL without credentials, drawn as a normal link (`target="_blank"`, `rel="noopener noreferrer"`) that shows its host next to the label and the full URL on hover. Any other scheme drops the item. |
| `copy` | Copies `value` (up to 4000 characters) to the clipboard. The button shows a preview of that exact text next to the model's label, with the full text on hover, so a label can't hide what gets copied. |
| `ask` | Puts `value` in the message box. The user still sends it. |

The extension also has one local action of its own: switching a chart between
chart and table view. No action sends a message, runs a browser-control
command or skips an approval. Model-supplied HTML, CSS, scripts, event
handlers and network requests are never run.

## Limits and safety

- A fence body over 32 KB is rejected. Text props are trimmed (most to 300
  characters, Markdown bodies to 4000).
- Every string is HTML-escaped. The whole output then goes through DOMPurify.
- The sensitive-text redaction used for Markdown runs on the whole reply first.
- Only Hermes' own replies use a response style. User, system and side-question
  messages keep the Markdown renderer on both surfaces.
- A `vivid` fence is walked with a visited set and a 200-node cap, so child
  ids that repeat or loop can't multiply the work.

## Streaming and restore

- A block's DOM id is `<fence offset>:<block id>`. Appending text never moves
  an earlier fence, so ids stay stable while a reply streams.
- While a reply streams, an unclosed `hermes-ui` fence draws a fixed-height
  placeholder, never partial JSON. It's replaced once, when the closing fence
  arrives. A settled reply never keeps a placeholder: a fence that runs to the
  end of the reply is read as it stands, and drawn or shown as text. The
  side panel's stream updater tells the renderer which reply is still
  streaming (`renderResponseSafe(text, { streaming })`); a caller that doesn't
  say keeps the old behaviour and treats an open fence as still arriving.
- Each block carries a content signature (`data-haui-sig`). The side panel's
  streaming patcher keeps a finished block in place, along with its chart or
  table view and open/closed state, while later text streams in.
- Rendering is a pure function of the saved text, so reloading a session draws
  the same blocks, and a reconnect can't duplicate them.

## Presentation layer for plain Markdown

With Vivid UI on, unambiguous shapes in ordinary Markdown are improved
without a second model call:

- A standalone list of 2 to 6 items shaped like `- **Label:** <number>` (with an
  optional `(note)`) becomes metric cards.
- A standalone list of 3 to 12 items shaped like `- **Label:** short text`
  becomes a key and value card. Values holding links, code or emphasis stay
  Markdown.
- A standalone list of 2 to 6 items that are each only an `https` link becomes
  link buttons.
- A table with a text label column and numeric columns (3 to 24 rows) gets a
  closed "View as chart" disclosure under it. The table stays as written.

Prose is never changed and no number is invented. A structure at the tail of a
reply that is still streaming is left alone until more text follows it.

## Hermes Mobile `vivid` fences

Fences labelled `vivid` (the Hermes Mobile catalog: A2UI v0.9 messages, one per
line) are read too. `Stat`, `Table`, `Chart` (bar/line), `Compare`, `Link` and
`Choices` map onto HAUI blocks; layout containers are walked. Everything else,
including `Tool` and `Form`, is left to the reply's prose.

## How the model is asked

With Vivid UI selected, the side panel adds a short guide to the Hermes
Browser system prompt (`responseStyleInstructions()` in
`extension/lib/response-presentation.mjs`). Rich text adds nothing. Plain text
asks for replies without Markdown. The full tab sends turns without a system
prompt, so it renders blocks when they're present but doesn't ask for them.

## Future work

- A structured-UI event from the gateway could carry the same envelope. The
  renderer takes an envelope directly (`renderAdaptiveBlocksHtml`).
- More block types (timeline, steps) once a catalog version 2 is agreed with
  Hermes Mobile.
