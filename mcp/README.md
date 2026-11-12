# VBLens MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents
analyse Visual Basic 5/6 executables (`.exe`, `.dll`, `.ocx`; native code and P-Code)
with the same engine as the VBLens app. It also hosts the app, connected live
to the agent's session (see [Working together in the app](#working-together-in-the-app)).

The server only reads and parses files. It never loads or runs the binary under
analysis, so it is safe to point at malware samples.

## In the desktop app (the normal way)

The desktop app runs this server as its engine (`--desktop`). There is nothing to install
separately:

1. In VBLens, open **AI agent** in the top bar → *AI agent settings* and turn on
   **Allow AI agents (MCP)**.
2. Copy the command it shows and run it once, e.g. for Claude Code:
   `claude mcp add --transport http vblens http://127.0.0.1:3920/mcp --header "Authorization: Bearer <token>"`.
   For Cursor, VS Code and other clients, copy the JSON shown below it.
3. Keep VBLens open while the agent works. Agents connect only while the switch is on,
   only from this computer, and only with the token (*New token* disconnects old setups).

Everything below describes running the server on its own (without the desktop app), which
is mainly useful for development, automation and headless machines.

## Build

```bash
npm install
npm run build            # the app (dist/index.html), which the server embeds
npm run build:mcp        # writes dist-mcp/vblens-mcp.mjs
```

`dist-mcp/vblens-mcp.mjs` is a single self-contained file (the app included). Copy it
anywhere and run it with Node.js 20.3 or newer; it needs no `node_modules`.

## Connect a client

**Claude Code**

```bash
claude mcp add vblens -- node /absolute/path/to/vblens-mcp.mjs
# or restricted to one samples folder:
claude mcp add vblens -- node /absolute/path/to/vblens-mcp.mjs --allow /home/me/samples
```

**Claude Desktop, Cursor and other clients** (`mcpServers` JSON config)

```json
{
  "mcpServers": {
    "vblens": {
      "command": "node",
      "args": ["C:\\Tools\\vblens-mcp.mjs", "--allow", "C:\\Samples"]
    }
  }
}
```

**Over HTTP** (agent on another machine or VM than the samples)

```bash
# on the machine that has the samples
VBLENS_MCP_TOKEN=choose-a-long-secret node vblens-mcp.mjs --http 3920 --host 0.0.0.0 --allow /samples
# on the agent's machine
claude mcp add --transport http vblens http://<host>:3920/mcp --header "Authorization: Bearer choose-a-long-secret"
```

Then ask the agent something like *"Open C:\Samples\app.exe with vblens and tell me what
it does with the registry and the network."*

## Working together in the app

While the server runs it also serves the VBLens app, by default at
**http://127.0.0.1:3920/** (the next free port if that one is taken; `vb_app_status` tells
the agent the address, and `vb_open_app` opens it in your browser). The app opened from
there uses the server's sessions instead of analysing in the page, so you and the agent
work on the same thing:

- **You watch the agent.** Files it opens appear in the app. With *Follow* on (the
  default), the app moves to what the agent reads (code, disassembly, graph, forms) and the
  status bar says what it is doing. Following pauses for a few seconds whenever you type,
  click or scroll, so it never pulls the view away while you work.
- **The agent points you at things.** `vb_show_in_app` moves the app to a procedure,
  address, form or control, with an optional note shown on screen.
- **The agent sees what you see.** `vb_get_user_view` returns your current file, tab,
  view, cursor address with the surrounding code, and any text you selected, so you can
  ask about "this procedure" or "the selected line".
- **One set of names.** Renames and comments made in the app or by the agent show up on
  both sides immediately and are saved by the server for the next session.
- **Your files too.** A file you drop into the app is analysed by the server and the agent
  can see it (`vb_list_files`). The agent cannot close a file you have on screen.

**Agent on a VM, browser on the host** (for example Claude Code on an Ubuntu VM and Chrome
on Windows): the app listens only on the VM's own `127.0.0.1` by default. Either forward
the port over SSH from the host:

```bash
ssh -L 3920:127.0.0.1:3920 you@the-vm      # then open http://127.0.0.1:3920/ on the host
```

or let the VM serve it on its network address with a token:

```bash
claude mcp add -e VBLENS_MCP_TOKEN=choose-a-long-secret --transport stdio vblens -- node /path/to/vblens-mcp.mjs --ui-host 0.0.0.0
# then open http://<vm-ip>:3920/?token=choose-a-long-secret on the host
```

The green **Live** chip in the app's top bar shows the connection. Click it to turn
following on or off and to switch between the files open on the server. If the server
stops (for example when the agent session ends), the app says so; reopen it from the new
server's address.

The standalone `VBLens.html` keeps working offline exactly as before; only the
copy served by the MCP server is live.

## Options

```
vblens-mcp [options] [file ...]

  file ...            binaries to open at startup (agents normally call vb_open_file)
  --allow <dir>       only allow opening files from, and exporting to, this directory (repeatable)
  --state-dir <dir>   where renames and comments are saved (default ~/.vblens)
  --no-persist        do not save renames and comments
  --http [port]       serve Streamable HTTP on /mcp instead of stdio (default port 3920);
                      the app is served on the same port
  --host <addr>       HTTP bind address (default 127.0.0.1)
  --ui-port <port>    stdio mode: port for the app (default: first free port from 3920)
  --ui-host <addr>    stdio mode: address the app listens on (default 127.0.0.1); any other
                      address needs VBLENS_MCP_TOKEN and ?token=<token> in the app address
  --no-ui             do not serve the app
  --desktop           run as the desktop app's engine (app + /mcp on one port, AI agent
                      switch and token managed in the app)
  --port <port>       --desktop: preferred port (default: saved setting, else 3920)

  VBLENS_MCP_TOKEN      bearer token HTTP clients must send; required for any non-local --host,
                      and then the app must be opened as http://<host>:<port>/?token=<token>
  VBLENS_ALLOWED_HOSTS  comma-separated Host names accepted when not bound to localhost
```

## Tools

All tools take an optional `file` (id of an open file; default is the most recently
opened one). Addresses are hex virtual addresses such as `0x00401A30`. Procedures can be
given as `Object.Name`, a bare name when unambiguous, or an address. List tools paginate
with `limit` / `offset` and can return JSON with `response_format: "json"`.

| Tool | What it does |
|---|---|
| `vb_open_file` | Load and analyse a binary; returns its file id and an overview |
| `vb_list_files`, `vb_close_file` | Manage the open binaries (up to 8 at once) |
| `vb_get_overview` | Hashes, project info, native/P-Code, sections, references, API libraries |
| `vb_list_objects` | Forms, modules, classes, user controls |
| `vb_list_procedures` | Procedures with address, kind and size; filter and sort |
| `vb_decompile` | Visual Basic source of one procedure (optionally with addresses) |
| `vb_decompile_object` | Source of a whole form / module / class |
| `vb_disassemble` | x86 or P-Code listing of a procedure, or raw x86 at an address |
| `vb_get_cfg` | Basic blocks and edges of a procedure |
| `vb_get_procedure_info` | Callers, callees and strings of a procedure |
| `vb_get_xrefs` | Who uses a procedure, string, global, runtime import or declared API |
| `vb_list_strings` | String literals, filter by substring or regex |
| `vb_list_imports` | PE imports (VB runtime functions) with use counts |
| `vb_list_api_declares` | `Declare`d Windows APIs with their callers |
| `vb_get_form` | A form's control tree, one control's properties, or its `.frm` text |
| `vb_search` | Fuzzy search over names, controls, strings, declares |
| `vb_search_code` | grep (substring or regex) over all decompiled code |
| `vb_resolve_address` | What an address is |
| `vb_read_bytes` | Hex dump at an address |
| `vb_rename` | Rename a procedure, global or code label (saved per file) |
| `vb_set_comment` | Attach a comment to a code address (saved per file) |
| `vb_load_type_library` | Name third-party ActiveX members from an `.ocx` / `.tlb` |
| `vb_export_project` | Write the decompiled project (`.vbp`, `.frm`, `.bas`, `.cls`, resources) to a folder |
| `vb_app_status` | The app's address, whether it is connected, and what the user has open |
| `vb_open_app` | Open the app in the user's default browser |
| `vb_get_user_view` | What the user is looking at: file, tab, view, cursor with surrounding code, selection |
| `vb_show_in_app` | Move the user's app to a procedure, address, form or control, with an optional note |

Renames and comments are stored under `~/.vblens/annotations/`, keyed by the
file's SHA-256, and re-applied whenever the same file is opened again. The app shares them
when it is opened from the server; renames you made earlier in the standalone app are
added to the server's set the first time you open that file there.

## Security notes

- **Untrusted content.** Names, strings, captions and comments in the output come from the
  analysed binary. The server tells agents to treat them as data, and keeps them on one
  line, but an agent that reads attacker-controlled text can still be misled: keep a
  human in the loop for anything it wants to do outside this server.
- **File access.** Without `--allow`, the server can open any file its user can read and
  `vb_export_project` can write to any folder its user can write. Use `--allow` to
  confine both. Exported file names are sanitised so that a hostile binary cannot write
  outside the chosen folder.
- **The app link** listens on `127.0.0.1` only (stdio mode). Its endpoints need a random
  token that only the served page knows, and they reject other Host and Origin headers, so
  other web pages and DNS-rebinding attacks cannot drive it; the page cannot be framed.
  The app can only call the analysis functions and edit renames/comments: it cannot make
  the server open paths or write files. Anyone who can open the app address on that
  machine sees the open files, as with any local web tool.
- **HTTP mode** binds to `127.0.0.1` by default with Host/Origin checks. It refuses to bind
  any other address unless `VBLENS_MCP_TOKEN` is set. The token is sent in clear text over
  plain HTTP: on untrusted networks put the server behind TLS or an SSH tunnel.

## Develop and test

```bash
npm run mcp -- --help                                   # run from source with tsx
npm run build:mcp
VB_SAMPLE=/path/to/vb6.exe npm run test:mcp             # self-check: every tool, errors, persistence, HTTP
(cd tests/e2e && VB_SAMPLE=... python3 live.py)        # agent (MCP) + user (browser) together; needs `pip install mcp playwright`
npx tsx mcp/corpus.ts a.exe b.ocx ...                   # robustness run over many binaries
npx @modelcontextprotocol/inspector node dist-mcp/vblens-mcp.mjs   # interactive exploration
```

Layout: `server.ts` (entry point, CLI, transports), `tools.ts` (analysis tools),
`apptools.ts` (app tools), `live.ts` (serves the app and its live channel), `state.ts`
(open files, saved annotations, path policy, name/address resolution), `build.mjs`
(bundles the server with the app embedded). The app side is `src/ui/live.ts`.
