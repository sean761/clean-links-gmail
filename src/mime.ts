/**
 * Builds and reads RFC 5322 / MIME email messages.
 *
 * Bodies are sent base64-encoded so that long lines, symbols and links pass
 * through untouched (no quoted-printable soft line breaks inside URLs).
 */

import { randomBytes } from "node:crypto";
import type { gmail_v1 } from "@googleapis/gmail";

export interface OutgoingMessage {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

/** Remove CR/LF so a value can never inject extra headers. */
export function sanitizeHeader(value: string | undefined, maxLength = 998): string {
  if (!value) return "";
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maxLength);
}

/** RFC 2047 encode a header value only when it contains non-ASCII characters. */
export function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function base64Lines(value: string): string {
  const encoded = Buffer.from(value, "utf-8").toString("base64");
  return encoded.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Build the full MIME message as a string (not yet base64url-encoded). */
export function buildMimeMessage(message: OutgoingMessage): string {
  const headers: string[] = [];
  const to = sanitizeHeader(message.to);
  const cc = sanitizeHeader(message.cc);
  const bcc = sanitizeHeader(message.bcc);
  const subject = sanitizeHeader(message.subject);
  const inReplyTo = sanitizeHeader(message.inReplyTo);
  const references = sanitizeHeader(message.references, 8000);

  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeaderWord(subject)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  headers.push("MIME-Version: 1.0");

  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
  ];

  if (!message.html) {
    return [...headers, ...textPart].join("\r\n") + "\r\n";
  }

  const boundary = `clg_${randomBytes(16).toString("hex")}`;
  return (
    [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...textPart,
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.html),
      `--${boundary}--`,
    ].join("\r\n") + "\r\n"
  );
}

export function buildRawMessage(message: OutgoingMessage): string {
  return toBase64Url(buildMimeMessage(message));
}

export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined | null,
  name: string
): string {
  const wanted = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? "";
}

export interface ParsedBody {
  text: string;
  html: string;
  attachments: { filename: string; mimeType: string; size: number }[];
}

/** Pull the first text/plain part, first text/html part, and attachment list from a payload. */
export function parsePayload(payload: gmail_v1.Schema$MessagePart | undefined | null): ParsedBody {
  const result: ParsedBody = { text: "", html: "", attachments: [] };
  let haveText = false;
  let haveHtml = false;

  const walk = (part: gmail_v1.Schema$MessagePart): void => {
    if (part.filename) {
      result.attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
      });
    } else if (part.mimeType === "text/plain" && part.body?.data && !haveText) {
      result.text = fromBase64Url(part.body.data);
      haveText = true;
    } else if (part.mimeType === "text/html" && part.body?.data && !haveHtml) {
      result.html = fromBase64Url(part.body.data);
      haveHtml = true;
    }
    for (const child of part.parts ?? []) walk(child);
  };

  if (payload) walk(payload);
  return result;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/**
 * Produce a readable plain-text version of an HTML body, used when only a
 * formatted body is supplied. Links become "words (address)".
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, inner) => {
      const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
      const target = decodeEntities(href).trim();
      if (!label) return target;
      if (label === target || target.replace(/^(mailto|tel):/i, "") === label) return label;
      return `${label} (${target})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|table|blockquote)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FoundLink {
  /** Where the link points. */
  target: string;
  /** What the reader sees (for HTML links). */
  visible_text?: string;
  /** Which body it was found in. */
  found_in: "plain text" | "formatted";
}

/** List every link in the bodies so a user can check them. */
export function listLinks(text: string, html: string): FoundLink[] {
  const links: FoundLink[] = [];
  for (const m of text.matchAll(/\b(?:https?:\/\/|mailto:|tel:)[^\s<>"']+/gi)) {
    links.push({ target: m[0].replace(/[.,;:!?)]+$/, ""), found_in: "plain text" });
  }
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({
      target: decodeEntities(m[2]),
      visible_text: decodeEntities(m[3].replace(/<[^>]+>/g, "")).trim(),
      found_in: "formatted",
    });
  }
  return links;
}

/** Split an address header into individual addresses, respecting quoted names. */
export function splitAddresses(header: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function emailOf(address: string): string {
  const angle = address.match(/<([^>]+)>/);
  return (angle ? angle[1] : address).trim().toLowerCase();
}
