#!/usr/bin/env node
/**
 * Clean Links Gmail: an MCP server for Claude Desktop that writes Gmail drafts
 * with every link saved exactly as written.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NotSignedInError, SetupError, resetSignIn, startSignIn } from "./auth.js";
import { BrokenRedirectError } from "./link-cleaner.js";
import * as mail from "./gmail.js";

const VERSION = "1.0.0";

const server = new McpServer({ name: "clean-links-gmail", version: VERSION });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function googleErrorMessage(error: unknown): string | null {
  const e = error as { message?: string; code?: number | string; response?: { data?: unknown } };
  const text = `${e?.message ?? ""} ${JSON.stringify(e?.response?.data ?? "")}`;
  if (/invalid_grant/i.test(text)) return "INVALID_GRANT";
  if (e?.code === 404 || /not found/i.test(e?.message ?? "")) {
    return "Gmail could not find that item. Check the ID and try again.";
  }
  if (e?.code === 403 && /insufficient/i.test(text)) return "INSUFFICIENT_SCOPE";
  return null;
}

async function signInPrompt(reason: string): Promise<ToolResult> {
  const { url } = await startSignIn();
  return fail(
    `${reason} A Google sign-in page just opened in the user's web browser. ` +
      `Ask the user to finish signing in there, then try this request again.\n\n` +
      `If no browser page opened, the user can open this address:\n${url}`
  );
}

/** Wrap a tool handler with friendly, plain-English error handling. */
function handle<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (error) {
      if (error instanceof BrokenRedirectError || error instanceof SetupError) return fail(error.message);
      if (error instanceof NotSignedInError) return signInPrompt("Not connected to Gmail yet.");
      const google = googleErrorMessage(error);
      if (google === "INVALID_GRANT") {
        await resetSignIn();
        return signInPrompt(
          "Google ended the saved sign-in (this happens about every 7 days for apps in Google's testing mode)."
        );
      }
      if (google === "INSUFFICIENT_SCOPE") {
        await resetSignIn();
        return signInPrompt("The Gmail sign-in is missing a permission this tool needs.");
      }
      if (google) return fail(google);
      console.error("[clean-links-gmail] Unexpected error:", error);
      return fail(`Something went wrong: ${(error as Error)?.message ?? String(error)}`);
    }
  };
}

const LINK_NOTE =
  "Links are saved exactly as written. Any Google redirect link (google.com/url?q=...) is replaced " +
  "with the real address first, and the reply lists every link that was cleaned so you can tell the user. " +
  "If a redirect link cannot be decoded, the draft is NOT saved and the error names the bad link.";

const bodyFields = {
  body: z
    .string()
    .optional()
    .describe("Plain-text version of the email. Write links as full addresses (https://...)."),
  html_body: z
    .string()
    .optional()
    .describe(
      "Optional formatted (HTML) version of the email, e.g. <p>Book a time <a href=\"https://...\">here</a>.</p>. " +
        "If only html_body is given, a plain-text version is made from it automatically."
    ),
};

server.registerTool(
  "gmail_sign_in",
  {
    title: "Sign in to Gmail",
    description:
      "Connect this tool to the user's Gmail by opening Google's sign-in page in their browser. " +
      "Only needed the first time, or if Google asks the user to sign in again.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  handle(async () => {
    const { url, alreadyWaiting } = await startSignIn();
    return {
      message: alreadyWaiting
        ? "A sign-in is already in progress. The Google page was opened again in the browser."
        : "Google's sign-in page opened in the browser. Finish signing in there, then come back.",
      sign_in_address: url,
    };
  })
);

server.registerTool(
  "gmail_connection_status",
  {
    title: "Check Gmail connection",
    description: "Check whether the tool is signed in to Gmail and which email address it uses.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async () => mail.connectionStatus())
);

server.registerTool(
  "create_draft",
  {
    title: "Create email draft",
    description: `Create a new Gmail draft. It is NOT sent. ${LINK_NOTE}`,
    inputSchema: {
      to: z.string().min(1).describe("Recipient address(es), comma-separated."),
      subject: z.string().describe("Subject line."),
      cc: z.string().optional().describe("Cc address(es), comma-separated."),
      bcc: z.string().optional().describe("Bcc address(es), comma-separated."),
      ...bodyFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  handle(mail.createDraft)
);

server.registerTool(
  "create_reply_draft",
  {
    title: "Create reply draft",
    description:
      "Create a draft reply inside an existing email conversation (same thread, correct reply headers). " +
      `It is NOT sent. Use search_emails to find the message_id first. ${LINK_NOTE}`,
    inputSchema: {
      message_id: z.string().min(1).describe("ID of the email being replied to (from search_emails or read_email)."),
      reply_all: z
        .boolean()
        .optional()
        .describe("true = reply to everyone on the email. false or missing = reply only to the sender."),
      cc: z.string().optional().describe("Extra Cc address(es) to add, comma-separated."),
      bcc: z.string().optional().describe("Bcc address(es), comma-separated."),
      ...bodyFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  handle(mail.createReplyDraft)
);

server.registerTool(
  "update_draft",
  {
    title: "Update email draft",
    description:
      "Change an existing draft. Only the fields you pass are changed; everything else is kept. " +
      `Passing body and/or html_body replaces the email text. ${LINK_NOTE}`,
    inputSchema: {
      draft_id: z.string().min(1).describe("ID of the draft to change."),
      to: z.string().optional(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      subject: z.string().optional(),
      ...bodyFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  handle(mail.updateDraft)
);

server.registerTool(
  "get_draft",
  {
    title: "Read a draft",
    description:
      "Read a draft back exactly as Gmail saved it, including a list of every link and whether any " +
      "Google redirect links are present. Set include_raw to true to see the raw saved email.",
    inputSchema: {
      draft_id: z.string().min(1),
      include_raw: z.boolean().optional().describe("Also return the raw saved email (for checking links)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async (args: { draft_id: string; include_raw?: boolean }) =>
    mail.getDraft(args.draft_id, args.include_raw ?? false)
  )
);

server.registerTool(
  "list_drafts",
  {
    title: "List drafts",
    description: "List Gmail drafts, newest first.",
    inputSchema: {
      max_results: z.number().int().min(1).max(100).optional().describe("How many to return (default 20)."),
      page_token: z.string().optional().describe("Token from a previous call to get the next page."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async (args: { max_results?: number; page_token?: string }) =>
    mail.listDrafts(args.max_results ?? 20, args.page_token)
  )
);

server.registerTool(
  "send_draft",
  {
    title: "Send a draft",
    description:
      "Send an existing draft. ONLY use this when the user has clearly asked to send this specific draft. " +
      "Never send on your own. Links are checked one last time before sending.",
    inputSchema: { draft_id: z.string().min(1).describe("ID of the draft to send.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  handle(async (args: { draft_id: string }) => mail.sendDraft(args.draft_id))
);

server.registerTool(
  "delete_draft",
  {
    title: "Delete a draft",
    description: "Permanently delete a draft. Only use when the user asks to delete it.",
    inputSchema: { draft_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  handle(async (args: { draft_id: string }) => mail.deleteDraft(args.draft_id))
);

server.registerTool(
  "search_emails",
  {
    title: "Search emails",
    description:
      'Search Gmail using normal Gmail search words (for example: from:jane@example.com subject:"trip" newer_than:7d). ' +
      "Returns message IDs you can reply to.",
    inputSchema: {
      query: z.string().min(1),
      max_results: z.number().int().min(1).max(50).optional().describe("Default 10."),
      page_token: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async (args: { query: string; max_results?: number; page_token?: string }) =>
    mail.searchEmails(args.query, args.max_results ?? 10, args.page_token)
  )
);

server.registerTool(
  "read_email",
  {
    title: "Read an email",
    description: "Read one email, including its links. Set include_raw to true to see the raw email.",
    inputSchema: {
      message_id: z.string().min(1),
      include_raw: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async (args: { message_id: string; include_raw?: boolean }) =>
    mail.readEmail(args.message_id, args.include_raw ?? false)
  )
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`[clean-links-gmail] v${VERSION} running`);
}

main().catch((error) => {
  console.error("[clean-links-gmail] Failed to start:", error);
  process.exit(1);
});
