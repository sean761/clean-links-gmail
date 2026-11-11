/**
 * Gmail operations. Every draft is passed through the link cleaner before it
 * is saved, and again before it is sent.
 */

import { gmail as createGmail, type gmail_v1 } from "@googleapis/gmail";
import { getAuthorizedClient } from "./auth.js";
import { cleanBody, containsRedirect, type CleanedLink } from "./link-cleaner.js";
import {
  buildRawMessage,
  emailOf,
  getHeader,
  htmlToText,
  listLinks,
  parsePayload,
  splitAddresses,
  type FoundLink,
  type OutgoingMessage,
} from "./mime.js";

const MAX_BODY_CHARS = 40_000;

async function api(): Promise<gmail_v1.Gmail> {
  const auth = await getAuthorizedClient();
  return createGmail({ version: "v1", auth, timeout: 30_000 });
}

export interface BodyInput {
  body?: string;
  html_body?: string;
}

export interface CleanedBodies {
  text: string;
  html?: string;
  cleaned: CleanedLink[];
}

/** Validate and clean the bodies. Throws BrokenRedirectError if a wrapper cannot be decoded. */
export function prepareBodies(input: BodyInput): CleanedBodies {
  const hasText = typeof input.body === "string" && input.body.length > 0;
  const hasHtml = typeof input.html_body === "string" && input.html_body.trim().length > 0;
  if (!hasText && !hasHtml) {
    throw new Error("The email needs a body: provide body (plain text), html_body (formatted), or both.");
  }
  const cleaned: CleanedLink[] = [];
  let html: string | undefined;
  if (hasHtml) {
    const result = cleanBody(input.html_body!, "html");
    html = result.value;
    cleaned.push(...result.cleaned);
  }
  let text: string;
  if (hasText) {
    const result = cleanBody(input.body!, "text");
    text = result.value;
    cleaned.push(...result.cleaned);
  } else {
    text = htmlToText(html!);
  }
  return { text, html, cleaned };
}

export interface DraftSummary {
  draft_id: string;
  message_id: string;
  thread_id: string;
  to: string;
  cc: string;
  subject: string;
  links_cleaned: CleanedLink[];
}

function summarize(
  draft: gmail_v1.Schema$Draft,
  message: OutgoingMessage,
  cleaned: CleanedLink[]
): DraftSummary {
  return {
    draft_id: draft.id ?? "",
    message_id: draft.message?.id ?? "",
    thread_id: draft.message?.threadId ?? "",
    to: message.to ?? "",
    cc: message.cc ?? "",
    subject: message.subject ?? "",
    links_cleaned: cleaned,
  };
}

export async function createDraft(input: {
  to: string;
  subject: string;
  cc?: string;
  bcc?: string;
} & BodyInput): Promise<DraftSummary> {
  const bodies = prepareBodies(input);
  const message: OutgoingMessage = {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: bodies.text,
    html: bodies.html,
  };
  const gmail = await api();
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: buildRawMessage(message) } },
  });
  return summarize(res.data, message, bodies.cleaned);
}

async function myAddress(gmail: gmail_v1.Gmail): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: "me" });
  return (profile.data.emailAddress ?? "").toLowerCase();
}

function dedupeAddresses(addresses: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const address of addresses) {
    const email = emailOf(address);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(address);
  }
  return out;
}

export async function createReplyDraft(input: {
  message_id: string;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
} & BodyInput): Promise<DraftSummary> {
  const bodies = prepareBodies(input);
  const gmail = await api();
  const original = await gmail.users.messages.get({
    userId: "me",
    id: input.message_id,
    format: "metadata",
    metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References"],
  });
  const headers = original.data.payload?.headers;
  const me = await myAddress(gmail);
  const from = getHeader(headers, "From");
  const replyTo = getHeader(headers, "Reply-To") || from;
  const sentByMe = emailOf(from) === me;

  // Replying to your own message goes back to its original recipients.
  let toList = sentByMe ? splitAddresses(getHeader(headers, "To")) : splitAddresses(replyTo);
  let ccList: string[] = [];
  if (input.reply_all) {
    const others = [
      ...(sentByMe ? [] : splitAddresses(getHeader(headers, "To"))),
      ...splitAddresses(getHeader(headers, "Cc")),
    ];
    toList = dedupeAddresses(toList, new Set());
    ccList = dedupeAddresses(others, new Set([me, ...toList.map(emailOf)]));
  }
  if (input.cc) ccList.push(...splitAddresses(input.cc));

  const messageIdHeader = getHeader(headers, "Message-ID");
  const references = [getHeader(headers, "References"), messageIdHeader].filter(Boolean).join(" ");
  const subject = getHeader(headers, "Subject");

  const message: OutgoingMessage = {
    to: toList.join(", "),
    cc: ccList.join(", "),
    bcc: input.bcc,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: bodies.text,
    html: bodies.html,
    inReplyTo: messageIdHeader,
    references,
  };
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw: buildRawMessage(message), threadId: original.data.threadId ?? undefined },
    },
  });
  return summarize(res.data, message, bodies.cleaned);
}

async function fetchDraft(gmail: gmail_v1.Gmail, draftId: string) {
  const res = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
  const headers = res.data.message?.payload?.headers;
  const parsed = parsePayload(res.data.message?.payload);
  return {
    draft: res.data,
    threadId: res.data.message?.threadId ?? undefined,
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    bcc: getHeader(headers, "Bcc"),
    subject: getHeader(headers, "Subject"),
    inReplyTo: getHeader(headers, "In-Reply-To"),
    references: getHeader(headers, "References"),
    ...parsed,
  };
}

export async function updateDraft(input: {
  draft_id: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
} & BodyInput): Promise<DraftSummary> {
  const gmail = await api();
  const existing = await fetchDraft(gmail, input.draft_id);

  const bodyChanged = input.body !== undefined || input.html_body !== undefined;
  const bodies = bodyChanged
    ? prepareBodies({
        body: input.body ?? (input.html_body !== undefined ? undefined : existing.text),
        html_body: input.html_body ?? (input.body !== undefined ? undefined : existing.html || undefined),
      })
    : prepareBodies({ body: existing.text || undefined, html_body: existing.html || undefined });

  if (existing.attachments.length > 0) {
    throw new Error(
      "This draft has attachments, which this tool cannot carry over. Edit it in Gmail instead, " +
        "or create a new draft."
    );
  }

  const message: OutgoingMessage = {
    to: input.to ?? existing.to,
    cc: input.cc ?? existing.cc,
    bcc: input.bcc ?? existing.bcc,
    subject: input.subject ?? existing.subject,
    text: bodies.text,
    html: bodies.html,
    inReplyTo: existing.inReplyTo,
    references: existing.references,
  };
  const res = await gmail.users.drafts.update({
    userId: "me",
    id: input.draft_id,
    requestBody: { message: { raw: buildRawMessage(message), threadId: existing.threadId } },
  });
  return summarize(res.data, message, bodies.cleaned);
}

function clip(value: string): string {
  return value.length > MAX_BODY_CHARS
    ? `${value.slice(0, MAX_BODY_CHARS)}\n[... cut off at ${MAX_BODY_CHARS} characters]`
    : value;
}

export async function getDraft(draftId: string, includeRaw: boolean) {
  const gmail = await api();
  const d = await fetchDraft(gmail, draftId);
  const links: FoundLink[] = listLinks(d.text, d.html);
  const result: Record<string, unknown> = {
    draft_id: d.draft.id,
    message_id: d.draft.message?.id,
    thread_id: d.threadId,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    is_reply: Boolean(d.inReplyTo),
    plain_text_body: clip(d.text),
    formatted_body: clip(d.html),
    attachments: d.attachments,
    links,
    google_redirect_links_found: containsRedirect(d.text) || containsRedirect(d.html),
  };
  if (includeRaw) {
    const raw = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "raw" });
    const data = raw.data.message?.raw ?? "";
    result.raw_saved_email = clip(Buffer.from(data, "base64url").toString("utf-8"));
  }
  return result;
}

export async function listDrafts(maxResults: number, pageToken?: string) {
  const gmail = await api();
  const res = await gmail.users.drafts.list({ userId: "me", maxResults, pageToken });
  const drafts = await Promise.all(
    (res.data.drafts ?? []).map(async (draft) => {
      const full = await gmail.users.drafts.get({
        userId: "me",
        id: draft.id!,
        format: "metadata",
      });
      const headers = full.data.message?.payload?.headers;
      return {
        draft_id: draft.id,
        thread_id: full.data.message?.threadId,
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        snippet: full.data.message?.snippet ?? "",
      };
    })
  );
  return { drafts, next_page_token: res.data.nextPageToken ?? null };
}

export async function sendDraft(draftId: string) {
  const gmail = await api();
  const d = await fetchDraft(gmail, draftId);
  let cleaned: CleanedLink[] = [];

  // Last check: if the draft was edited somewhere else and picked up redirect
  // wrappers, clean them before sending (or refuse if that is not safe).
  if (containsRedirect(d.text) || containsRedirect(d.html)) {
    if (d.attachments.length > 0) {
      throw new Error(
        "Not sent. This draft contains Google redirect links and has attachments, so it cannot be " +
          "cleaned automatically. Fix the links in Gmail, then send again."
      );
    }
    const updated = await updateDraft({ draft_id: draftId });
    cleaned = updated.links_cleaned;
  }

  const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  return {
    sent: true,
    message_id: res.data.id,
    thread_id: res.data.threadId,
    to: d.to,
    subject: d.subject,
    links_cleaned_before_sending: cleaned,
  };
}

export async function deleteDraft(draftId: string) {
  const gmail = await api();
  await gmail.users.drafts.delete({ userId: "me", id: draftId });
  return { deleted: true, draft_id: draftId };
}

export async function searchEmails(query: string, maxResults: number, pageToken?: string) {
  const gmail = await api();
  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults, pageToken });
  const emails = await Promise.all(
    (res.data.messages ?? []).map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      const headers = msg.data.payload?.headers;
      return {
        message_id: msg.data.id,
        thread_id: msg.data.threadId,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        snippet: msg.data.snippet ?? "",
      };
    })
  );
  return { emails, next_page_token: res.data.nextPageToken ?? null };
}

export async function readEmail(messageId: string, includeRaw: boolean) {
  const gmail = await api();
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = res.data.payload?.headers;
  const parsed = parsePayload(res.data.payload);
  const result: Record<string, unknown> = {
    message_id: res.data.id,
    thread_id: res.data.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    labels: res.data.labelIds ?? [],
    plain_text_body: clip(parsed.text),
    formatted_body: clip(parsed.html),
    attachments: parsed.attachments,
    links: listLinks(parsed.text, parsed.html),
  };
  if (includeRaw) {
    const raw = await gmail.users.messages.get({ userId: "me", id: messageId, format: "raw" });
    result.raw_email = clip(Buffer.from(raw.data.raw ?? "", "base64url").toString("utf-8"));
  }
  return result;
}

export async function connectionStatus() {
  const gmail = await api();
  const profile = await gmail.users.getProfile({ userId: "me" });
  return { signed_in: true, email_address: profile.data.emailAddress };
}
