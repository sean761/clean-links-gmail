# Clean Links Gmail

**Let Claude write your Gmail drafts without breaking your links.**

Made by Sean Grant. Free and open source (MIT License).

---

## The problem this fixes

When Claude writes a Gmail draft through the built-in Gmail connector, links in the draft can get rewritten into Google redirect links. Your reader clicks and lands on a Google "Redirect Notice" page instead of your website.

**Before (what your reader gets with the built-in connector):**

```
https://www.google.com/url?q=https://calendly.com/yourname&source=gmail&ust=1793890030681000&sa=E
```

**After (what your reader gets with Clean Links Gmail):**

```
https://calendly.com/yourname
```

Background: [public bug report](https://github.com/anthropics/claude-code/issues/66010).

## What it does

- Claude can create, edit, read back, and list your Gmail drafts, and create replies inside an existing email conversation (with a reply-all option).
- Every link is saved exactly as written.
- If a broken Google redirect link sneaks in (for example, you paste one from an old email), it is turned back into the real address before the draft is saved. Claude tells you which links it fixed.
- If a redirect link is too damaged to repair, the draft is **not** saved, and Claude tells you which link is the problem.
- Emails can be plain text or formatted (bold, headings, links on words like "click here").
- **It never sends anything on its own.** Sending is a separate step that only happens when you ask Claude to send a specific draft.

## What you need

- Claude Desktop (Mac or Windows), signed in to your Claude account.
- A Gmail or Google Workspace email account.
- About 15 minutes for the one-time Google setup below.

---

## Step 1: Get your own Google credentials (one time)

Google requires every app that touches Gmail to have its own "credentials." You make your own, so your email never passes through anyone else's app. This is the longest part. Take it one step at a time.

### 1a. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with the Google account whose email you want to use.
2. If this is your first time, accept the terms.
3. At the top of the page, click the project picker (it may say "Select a project"), then click **New project**.
4. Name it `Clean Links Gmail` and click **Create**.
5. Make sure the new project is selected in the project picker at the top before you continue.

### 1b. Turn on the Gmail API

1. Open the menu (the three lines at top left) and go to **APIs & Services** > **Library**.
2. Search for **Gmail API** and click it.
3. Click **Enable**.

### 1c. Set up the sign-in screen

1. Open the menu and go to **Google Auth platform** > **Branding**. ([Direct link](https://console.cloud.google.com/auth/branding))
2. If you see "Google Auth platform not configured yet," click **Get started**.
3. **App name:** type `Clean Links Gmail`. **User support email:** choose your email. Click **Next**.
4. **Audience:** choose your user type:
   - **Internal** if you have a Google Workspace business account and see this option. This is the better choice: you will not have to sign in again every week.
   - **External** if you use a personal Gmail account (or Internal is not offered).
5. Click **Next**. **Contact information:** enter your email. Click **Next**.
6. Check the box to agree to the Google API Services User Data Policy. Click **Continue**, then **Create**.

### 1d. Add yourself as a test user (External only)

Skip this if you chose Internal.

1. Go to **Google Auth platform** > **Audience**. ([Direct link](https://console.cloud.google.com/auth/audience))
2. Under **Test users**, click **Add users**.
3. Type your own email address and click **Save**.

### 1e. Add the Gmail permissions

1. Go to **Google Auth platform** > **Data Access**. ([Direct link](https://console.cloud.google.com/auth/scopes))
2. Click **Add or remove scopes**.
3. In the filter box, find and check these two (or paste them into "Manually add scopes"):
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.readonly`
4. Click **Update**, then **Save**.

### 1f. Create your Client ID and Client Secret

1. Go to **Google Auth platform** > **Clients**. ([Direct link](https://console.cloud.google.com/auth/clients))
2. Click **Create client**.
3. **Application type:** choose **Desktop app**.
4. **Name:** type `Clean Links Gmail`. Leave the other options as they are.
5. Click **Create**.
6. **Important:** a box shows your **Client ID** and **Client Secret**. Google only shows the full secret **this one time**. Click **Download JSON** or copy both values into a safe place (like your password manager) right now.
   - The Client ID ends with `.apps.googleusercontent.com`.
   - If you lose the secret, you can add a new secret to the same client, or simply create a new client.

**About signing in again:** if you chose **External**, Google keeps your app in "testing" mode, and Google ends test sign-ins **7 days** after you approve them. When that happens, Claude will open the Google sign-in page for you again; just sign in and carry on. If you chose **Internal** (Google Workspace only), this weekly sign-in does not apply.

---

## Step 2: Install Clean Links Gmail in Claude Desktop

1. Go to the [Releases page](https://github.com/sean761/clean-links-gmail/releases/latest) and download the file ending in **.mcpb**.
2. Double-click the downloaded file. Claude Desktop opens an install screen.
   - If double-clicking does not work: in Claude Desktop, open **Settings** > **Extensions** and drag the file onto that page.
3. Click **Install**.
4. When asked, paste your **Google Client ID** and **Google Client Secret** from Step 1f. Claude Desktop stores the secret in your computer's secure keychain.
5. Make sure the extension is turned on.

## Step 3: Connect your Gmail (one time)

1. Start a new chat in Claude Desktop and type: **"Use Clean Links Gmail to check my Gmail connection."**
2. A Google sign-in page opens in your web browser. Choose your account.
3. If you chose External, Google shows a warning that it hasn't verified the app. This is expected because it is your own app. Click **Continue**.
4. Approve the permissions and close the browser tab when it says "You're signed in."
5. Back in Claude, ask again. Claude should tell you which email address is connected.

---

## Step 4: Make Claude use this tool instead of the built-in Gmail connector

If you also have Claude's built-in Gmail connector turned on, Claude might pick it for writing drafts. Do both of these:

**A. Block the built-in connector's writing tools (recommended).**

1. In Claude, go to **Customize** > **Connectors** ([direct link](https://claude.ai/customize/connectors)) and select **Gmail**.
2. Under **Tool permissions**, set the tools that create, update, or send drafts or emails to **Blocked**. You can leave the search and read tools on.

**B. Give Claude a standing instruction.** Paste this into your Claude profile preferences or project instructions:

```
When writing, editing, replying to, or sending Gmail, always use the Clean Links Gmail tools
(create_draft, create_reply_draft, update_draft, send_draft). Never use the built-in Gmail
connector to create or send email, because it breaks links. Never send an email unless I
clearly ask you to send that specific draft.
```

---

## How to check a draft's links

Ask Claude: **"Read back that draft with get_draft and list every link."**

Claude shows each link, what text it sits on, and whether any Google redirect links are present. For the strictest check, ask for **"get_draft with include_raw"** to see the email exactly as Gmail saved it.

## The tools

| Tool | What it does |
|---|---|
| `gmail_sign_in` | Opens Google's sign-in page in your browser. |
| `gmail_connection_status` | Shows which Gmail address is connected. |
| `create_draft` | Creates a new draft (plain text and/or formatted). |
| `create_reply_draft` | Creates a reply in an existing conversation. Reply-all is optional. |
| `update_draft` | Changes an existing draft. |
| `get_draft` | Reads a draft back, with a list of every link. |
| `list_drafts` | Lists your drafts. |
| `send_draft` | Sends a draft. Only when you ask. |
| `delete_draft` | Deletes a draft. Only when you ask. |
| `search_emails` | Finds emails, so Claude can reply to the right one. |
| `read_email` | Reads one email, with its links. |

**Gmail permissions requested:** `gmail.compose` (to create, edit, and send your drafts) and `gmail.readonly` (to find and read the email you are replying to). It cannot delete your emails, change labels, or archive anything.

---

## Troubleshooting

**"Your Google Client ID and Client Secret are missing."**
Open Claude Desktop **Settings** > **Extensions** > **Clean Links Gmail** and paste them in again.

**"Access blocked" or "Error 403: access_denied" on the Google page.**
You chose External but did not add yourself as a test user. Do Step 1d, then try again.

**"Error 400: redirect_uri_mismatch" on the Google page.**
Your credential is not a Desktop app. Do Step 1f again and choose **Desktop app**.

**Claude says Google ended the sign-in.**
Normal every 7 days for External (testing) apps. Sign in again on the page that opens.

**The browser did not open.**
Claude shows a sign-in link in the chat. Copy it into your browser.

**Claude used the built-in Gmail connector anyway.**
Do both parts of Step 4, then start a new chat.

**Start over completely.**
Delete the folder `.clean-links-gmail` in your home folder (it holds your saved sign-in), then sign in again. To remove the app's access from your Google account, visit [myaccount.google.com/connections](https://myaccount.google.com/connections).

---

## Privacy

- Clean Links Gmail runs on **your own computer**.
- Your email travels **only between your computer and Google**. Nothing is sent to the author or to any other server.
- Your sign-in is saved only on your computer, in a folder only your user account can read (`.clean-links-gmail` in your home folder). Your Client Secret is kept in your computer's secure keychain by Claude Desktop.
- You use your own Google credentials, so no one else's app ever has access to your mail.

## For developers

```
npm install
npm test        # automated tests for the link cleaner and email builder
npm run pack    # builds dist/clean-links-gmail-<version>.mcpb
```

The link cleaner is in `src/link-cleaner.ts`. Third-party license notices are bundled in `THIRD-PARTY-NOTICES.txt` inside the install file.

## License

MIT License. Copyright (c) 2026 Sean Grant. See [LICENSE](LICENSE).
