# Third-party notices

## P-Code opcode table
`src/core/data/pcode-opcodes.json` is derived from `data/opcodes.csv` of the
[`visualbasic`](https://crates.io/crates/visualbasic) Rust crate (version 0.2.1),
licensed under the Apache License 2.0. The full license text is in
`third_party/visualbasic-crate-LICENSE.txt`. Changes: converted to JSON and reduced to the
fields used here (size, mnemonic, operand format, stack effects, category).

## Runtime and type information tables
`src/core/data/vb6lib.json` (interfaces, members, dispatch ids and events of the VB6
intrinsic classes) and `src/core/data/msvbvm.json` (MSVBVM50/60 export ordinals → names)
are factual interoperability tables describing the public COM interfaces and export tables
of the Visual Basic runtime. Visual Basic, VB6.OLB and MSVBVM60.DLL are trademarks / files
of Microsoft Corporation; no Microsoft code is included.

## Bundled libraries
- React and React DOM — MIT License, © Meta Platforms, Inc. and affiliates.
- fflate — MIT License, © Arjun Barrett.
- Inter (via @fontsource/inter) — SIL Open Font License 1.1, © The Inter Project Authors.
- JetBrains Mono (via @fontsource/jetbrains-mono) — SIL Open Font License 1.1, © JetBrains s.r.o.
- MCP TypeScript SDK (@modelcontextprotocol/server, /node, /express), Express, Zod — MIT
  License (bundled into the engine; `npm run build:mcp` writes all their license texts to
  `dist-mcp/THIRD_PARTY_NOTICES.txt`).

## Desktop app
The Windows/Linux builds are made with [Electron](https://www.electronjs.org) (MIT License)
and include Chromium; their license files (`LICENSE`, `LICENSES.chromium.html`) ship next
to the program.

## Development tools
Vite, TypeScript, tsx, vite-plugin-singlefile, @vitejs/plugin-react — MIT / Apache-2.0
licensed build tools (not shipped in the build output).
