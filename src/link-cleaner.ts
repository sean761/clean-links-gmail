/**
 * Link cleaner.
 *
 * Finds Google redirect wrappers such as
 *   https://www.google.com/url?q=https://example.com&source=gmail&ust=...&sa=E
 * and replaces each one with the real link it points to.
 *
 * Only links whose host is exactly google.com or www.google.com AND whose path
 * is exactly /url are touched. Every other link (including real Google Maps,
 * Docs and Drive links) is left alone, byte for byte.
 */

export interface CleanedLink {
  /** The wrapper exactly as it appeared in the input. */
  original: string;
  /** The real link that replaced it. */
  cleaned: string;
}

export interface CleanResult {
  value: string;
  cleaned: CleanedLink[];
}

export type BodyKind = "text" | "html";

/** Thrown when a wrapper cannot be turned into a valid http or https link. */
export class BrokenRedirectError extends Error {
  readonly links: { link: string; reason: string }[];

  constructor(links: { link: string; reason: string }[]) {
    const list = links.map((l) => `  - ${l.link}\n    (${l.reason})`).join("\n");
    super(
      `Draft NOT saved. Found ${links.length} broken Google redirect link(s) that could not be ` +
        `turned back into a real web address:\n${list}\n` +
        `Replace each one with the real address and try again.`
    );
    this.name = "BrokenRedirectError";
    this.links = links;
  }
}

const REDIRECT_HOSTS = new Set(["google.com", "www.google.com"]);
const MAX_NESTING = 10;

/**
 * Candidate wrapper inside free text or HTML. The lookbehind stops matches such
 * as "notgoogle.com/url?" or "maps.google.com/url?". The scheme is optional so a
 * bare "www.google.com/url?q=..." pasted into plain text is also caught.
 */
const WRAPPER_PATTERN =
  /(?<![\w.@/-])(?:https?:\/\/)?(?:www\.)?google\.com\/url\?[^\s<>"'`]+/gi;

/** Decode the few HTML entities that can appear inside a URL in markup. */
function decodeUrlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&#0*61;/g, "=")
    .replace(/&#x0*3d;/gi, "=");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function withScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function tryParse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** True when the value is a Google redirect wrapper (host google.com / www.google.com, path /url). */
export function isGoogleRedirect(value: string): boolean {
  const url = tryParse(withScheme(decodeUrlEntities(value.trim())));
  if (!url) return false;
  return REDIRECT_HOSTS.has(url.hostname.toLowerCase()) && url.pathname === "/url";
}

/**
 * Turn one wrapper (possibly nested several levels deep) into the real link.
 * Throws an Error with a plain-English reason when that is not possible.
 */
export function resolveRedirect(wrapper: string): string {
  let current = decodeUrlEntities(wrapper.trim());

  for (let depth = 0; depth <= MAX_NESTING; depth++) {
    const url = tryParse(withScheme(current));
    if (!url) throw new Error("not a readable web address");

    const isWrapper = REDIRECT_HOSTS.has(url.hostname.toLowerCase()) && url.pathname === "/url";
    if (!isWrapper) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`real link must start with http or https, found "${url.protocol}"`);
      }
      if (!url.hostname) throw new Error("real link has no website name");
      return current;
    }

    let target = url.searchParams.get("q") ?? url.searchParams.get("url");
    if (target === null || target.trim() === "") {
      throw new Error('no real link found in the "q" or "url" part of the wrapper');
    }
    target = decodeUrlEntities(target.trim());
    // Handle a target that was percent-encoded twice (https%3A%2F%2F...).
    if (/^https?%3a/i.test(target)) {
      try {
        target = decodeURIComponent(target);
      } catch {
        throw new Error("real link is garbled and cannot be decoded");
      }
    }
    if (!/^https?:\/\//i.test(target)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        throw new Error(`real link must start with http or https, found "${target.split(":")[0]}:"`);
      }
      throw new Error(`real link "${target}" does not start with http:// or https://`);
    }
    current = target;
  }

  throw new Error(`wrapped more than ${MAX_NESTING} times`);
}

/** Strip punctuation that ends a sentence rather than the link. */
function splitTrailingPunctuation(match: string): [string, string] {
  let link = match;
  let trailing = "";
  for (;;) {
    const last = link.slice(-1);
    if (".,;:!?".includes(last) && last !== "") {
      trailing = last + trailing;
      link = link.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (link.match(/\(/g) ?? []).length;
      const closes = (link.match(/\)/g) ?? []).length;
      if (closes > opens) {
        trailing = last + trailing;
        link = link.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return [link, trailing];
}

/**
 * Clean every wrapper in a body. Throws BrokenRedirectError (listing every bad
 * link) if any wrapper cannot be decoded, so nothing half-cleaned is ever saved.
 */
export function cleanBody(value: string, kind: BodyKind): CleanResult {
  const cleaned: CleanedLink[] = [];
  const broken: { link: string; reason: string }[] = [];

  const output = value.replace(WRAPPER_PATTERN, (match) => {
    const [link, trailing] = splitTrailingPunctuation(match);
    if (!isGoogleRedirect(link)) return match;
    try {
      const real = resolveRedirect(link);
      cleaned.push({ original: link, cleaned: real });
      return (kind === "html" ? escapeHtmlAttribute(real) : real) + trailing;
    } catch (error) {
      broken.push({ link, reason: (error as Error).message });
      return match;
    }
  });

  if (broken.length > 0) throw new BrokenRedirectError(broken);
  return { value: output, cleaned };
}

/** True when the body still contains any Google redirect wrapper. */
export function containsRedirect(value: string): boolean {
  for (const match of value.matchAll(WRAPPER_PATTERN)) {
    const [link] = splitTrailingPunctuation(match[0]);
    if (isGoogleRedirect(link)) return true;
  }
  return false;
}
