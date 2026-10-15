// Control UI config module wires control ui chunking behavior.
export function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

export function moduleIdIncludesPackage(id: string, packageName: string): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.includes(`/openclaw-pnpm-node-modules/${packageName}/`)
  );
}

export function controlUiManualChunk(id: string): string | undefined {
  if (
    moduleIdIncludesPackage(id, "lit") ||
    moduleIdIncludesPackage(id, "lit-html") ||
    moduleIdIncludesPackage(id, "@lit/reactive-element")
  ) {
    return "lit-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "highlight.js") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "markdown-it-task-lists") ||
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    return "markdown-runtime";
  }

  // zod serves only the lazily loaded config form; json5 is also read by the config controller in
  // the entry. Sharing one chunk made every first load fetch zod for json5's sake.
  if (moduleIdIncludesPackage(id, "zod")) {
    return "config-runtime";
  }

  if (moduleIdIncludesPackage(id, "json5")) {
    return "json5-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "@noble/ed25519") ||
    moduleIdIncludesPackage(id, "@noble/hashes") ||
    moduleIdIncludesPackage(id, "ipaddr.js")
  ) {
    return "gateway-runtime";
  }

  return undefined;
}
