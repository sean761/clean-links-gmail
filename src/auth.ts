/**
 * Google sign-in for a desktop app (OAuth 2.0 loopback flow with PKCE).
 *
 * - The user's own Client ID and Client Secret come from environment variables
 *   that Claude Desktop fills in from the extension settings (the secret is kept
 *   in the operating system keychain by Claude Desktop).
 * - The resulting sign-in token is saved only on this computer, in a folder
 *   readable only by the current user (folder 0700, file 0600).
 * - Nothing is sent anywhere except Google.
 */

import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";

export const SCOPES = [
  // Create, edit, read, list, send and delete drafts.
  "https://www.googleapis.com/auth/gmail.compose",
  // Find and read the email being replied to, and read back sent copies.
  "https://www.googleapis.com/auth/gmail.readonly",
];

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export class SetupError extends Error {}

export class NotSignedInError extends Error {}

export function dataDirectory(): string {
  return process.env.CLEAN_LINKS_GMAIL_HOME || join(homedir(), ".clean-links-gmail");
}

function tokenPath(): string {
  return join(dataDirectory(), "token.json");
}

function readClientConfig(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const unfilled = (v: string) => !v || v.startsWith("${user_config.");
  if (unfilled(clientId) || unfilled(clientSecret)) {
    throw new SetupError(
      "Your Google Client ID and Client Secret are missing. In Claude Desktop open " +
        "Settings > Extensions > Clean Links Gmail and paste them in, then try again."
    );
  }
  if (!clientId.endsWith(".apps.googleusercontent.com")) {
    throw new SetupError(
      'The Google Client ID does not look right. It should end with ".apps.googleusercontent.com". ' +
        "Check it in Claude Desktop under Settings > Extensions > Clean Links Gmail."
    );
  }
  return { clientId, clientSecret };
}

async function saveToken(tokens: Credentials): Promise<void> {
  const dir = dataDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const file = tokenPath();
  await writeFile(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

async function loadToken(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(tokenPath(), "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

export async function forgetToken(): Promise<void> {
  await rm(tokenPath(), { force: true });
}

let cachedClient: OAuth2Client | null = null;

/** Return a signed-in client, or throw NotSignedInError / SetupError. */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  if (cachedClient) return cachedClient;
  const { clientId, clientSecret } = readClientConfig();
  const stored = await loadToken();
  if (!stored?.refresh_token) {
    throw new NotSignedInError("Not signed in to Google yet.");
  }
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(stored);
  // Google sends fresh access tokens over time; keep the saved copy current.
  client.on("tokens", (tokens) => {
    const merged = { ...stored, ...tokens, refresh_token: tokens.refresh_token ?? stored.refresh_token };
    void saveToken(merged).catch((error) =>
      console.error("[clean-links-gmail] Could not save refreshed token:", error)
    );
  });
  cachedClient = client;
  return client;
}

/** Called when Google rejects the saved sign-in (for example, expired after 7 days in testing mode). */
export async function resetSignIn(): Promise<void> {
  cachedClient = null;
  await forgetToken();
}

function openInBrowser(url: string): void {
  const os = platform();
  const [command, args] =
    os === "darwin"
      ? ["open", [url]]
      : os === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is also returned to Claude, so the user can open it by hand.
  }
}

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:80px auto;line-height:1.5">
<h2>${title}</h2><p>${message}</p></body></html>`;
}

let pendingSignIn: { url: string; server: Server } | null = null;

/**
 * Start the Google sign-in. Opens the user's browser and waits in the
 * background (up to 10 minutes) for Google to send the user back.
 * Returns immediately with the sign-in address.
 */
export async function startSignIn(): Promise<{ url: string; alreadyWaiting: boolean }> {
  if (pendingSignIn) {
    openInBrowser(pendingSignIn.url);
    return { url: pendingSignIn.url, alreadyWaiting: true };
  }

  const { clientId, clientSecret } = readClientConfig();
  const state = randomBytes(24).toString("hex");

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the sign-in helper.");
  const redirectUri = `http://127.0.0.1:${address.port}`;

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  const finish = () => {
    clearTimeout(timer);
    server.close();
    pendingSignIn = null;
  };
  const timer = setTimeout(finish, SIGN_IN_TIMEOUT_MS);
  timer.unref();

  server.on("request", async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", redirectUri);
    if (requestUrl.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const send = (status: number, title: string, message: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(title, message));
    };

    if (requestUrl.searchParams.get("state") !== state) {
      send(400, "Sign-in link expired", "Please go back to Claude and ask it to sign in again.");
      return;
    }
    const googleError = requestUrl.searchParams.get("error");
    if (googleError) {
      send(400, "Sign-in cancelled", `Google said: ${googleError.replace(/[^\w .-]/g, "")}. Go back to Claude and try again.`);
      finish();
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      send(400, "Sign-in failed", "Google did not send a sign-in code. Go back to Claude and try again.");
      return;
    }
    try {
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
      if (!tokens.refresh_token) throw new Error("Google did not return a long-term sign-in token.");
      await saveToken(tokens);
      cachedClient = null;
      send(200, "You're signed in", "Clean Links Gmail is connected. You can close this tab and go back to Claude.");
    } catch (error) {
      console.error("[clean-links-gmail] Token exchange failed:", error);
      send(500, "Sign-in failed", "Something went wrong finishing the sign-in. Go back to Claude and try again.");
    } finally {
      finish();
    }
  });

  pendingSignIn = { url, server };
  openInBrowser(url);
  return { url, alreadyWaiting: false };
}
