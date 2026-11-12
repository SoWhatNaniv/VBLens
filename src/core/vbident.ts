// Shared by the UI rename prompt and the MCP server.

/** VB identifiers: letter first, then letters, digits and underscores, max 255 chars. */
export function vbIdentifierError(name: string): string | undefined {
  if (!name) return 'Name cannot be empty';
  if (name.length > 255) return 'Name is longer than 255 characters';
  if (!/^[A-Za-zÀ-￿]/.test(name)) return 'Name must start with a letter';
  if (!/^[A-Za-zÀ-￿][\wÀ-￿]*$/.test(name)) return 'Use only letters, digits and underscores';
  if (/^(and|as|byref|byval|call|case|const|dim|do|each|else|elseif|end|enum|erase|error|exit|false|for|function|get|global|gosub|goto|if|implements|in|is|let|like|loop|me|mod|new|next|not|nothing|on|option|optional|or|private|property|public|redim|rem|resume|select|set|static|step|stop|sub|then|to|true|type|until|wend|while|with|xor)$/i.test(name)) return `"${name}" is a reserved word`;
  return undefined;
}
