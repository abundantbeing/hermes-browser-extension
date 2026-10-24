// Palette helpers shared by the contrast tests: read a theme's tokens straight
// from the stylesheets and compute WCAG contrast from them. Same readers as
// tests/theme-contrast.test.mjs (kept there as private functions).

export function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function rules(css) {
  const source = withoutComments(css);
  const out = [];
  let index = 0;
  let selectorStart = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '{') {
      const selector = source.slice(selectorStart, index).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let end = index + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
        end += 1;
      }
      out.push({ selector, body: source.slice(index + 1, end - 1) });
      index = end;
      selectorStart = index;
      continue;
    }
    if (char === '}') selectorStart = index + 1;
    index += 1;
  }
  return out;
}

export function declarations(body) {
  const out = new Map();
  for (const match of body.matchAll(/([-a-zA-Z0-9_]+)\s*:\s*([^;{}]+)/g)) {
    out.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return out;
}

export function themeTokenBlocks(css) {
  return rules(css)
    .filter((rule) => /^html\[data-hermes-theme/.test(rule.selector) && !/[.:#\s]>+[^{]*\{/.test(rule.selector))
    .map((rule) => {
      const theme = /data-hermes-theme(?:="([^"]*)")?/.exec(rule.selector)?.[1] ?? '';
      const mode = /data-hermes-mode="([^"]+)"/.exec(rule.selector)?.[1] ?? '';
      return { selector: rule.selector, theme, mode, tokens: declarations(rule.body) };
    });
}

export function paletteFor(fileCssList, theme, mode) {
  const tokens = new Map();
  for (const css of fileCssList) {
    for (const block of themeTokenBlocks(css)) {
      const matchesRoot = block.selector === ':root';
      const matchesTheme = block.theme === theme && (block.mode === mode || block.mode === '');
      if (matchesRoot || matchesTheme) {
        for (const [key, value] of block.tokens) tokens.set(key, value);
      }
    }
  }
  return tokens;
}

export function resolveToken(tokens, name, seen = new Set()) {
  const value = tokens.get(name);
  if (value === undefined || seen.has(name)) return undefined;
  const reference = /^var\(\s*(--[-a-zA-Z0-9_]+)\s*(?:,([\s\S]*))?\)$/.exec(value.trim());
  if (!reference) return value;
  seen.add(name);
  const resolved = resolveToken(tokens, reference[1], seen);
  if (resolved !== undefined) return resolved;
  return reference[2] === undefined ? undefined : resolveToken(tokens, reference[2].trim(), seen);
}

export function substitute(tokens, value, depth = 0) {
  if (depth > 8 || typeof value !== 'string') return value;
  return value.replace(/var\(\s*(--[-a-zA-Z0-9_]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (match, name, fallback) => {
    const resolved = resolveToken(tokens, name);
    if (resolved !== undefined) return substitute(tokens, resolved, depth + 1);
    if (fallback !== undefined) return substitute(tokens, fallback.trim(), depth + 1);
    return match;
  });
}

export function color(value, over = { r: 255, g: 255, b: 255 }) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/(.)/g, '$1$1') : hex[1];
    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
  if (!rgb) return undefined;
  const parsed = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  if (parsed.a >= 1) return parsed;
  return {
    r: parsed.r * parsed.a + over.r * (1 - parsed.a),
    g: parsed.g * parsed.a + over.g * (1 - parsed.a),
    b: parsed.b * parsed.a + over.b * (1 - parsed.a),
    a: 1,
  };
}

export function luminance({ r, g, b }) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

