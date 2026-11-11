import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  buildRawMessage,
  emailOf,
  fromBase64Url,
  htmlToText,
  listLinks,
  splitAddresses,
} from "../src/mime.js";
import { prepareBodies } from "../src/gmail.js";

function decodeParts(mime: string): string[] {
  return [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$)/g)].map(
    (m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf-8")
  );
}

describe("buildMimeMessage", () => {
  it("builds plain text only when no HTML is given", () => {
    const mime = buildMimeMessage({ to: "a@example.com", subject: "Hi", text: "Hello https://calendly.com/example" });
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).not.toContain("multipart");
    expect(decodeParts(mime)).toEqual(["Hello https://calendly.com/example"]);
  });

  it("builds multipart/alternative with both parts, links byte-for-byte intact", () => {
    const link = "https://www.example.org/?utm_source=email&utm_medium=test&ref=a%20b#contact";
    const html = `<p>Book <a href="${link.replace(/&/g, "&amp;")}">here</a></p>`;
    const mime = buildMimeMessage({ to: "a@example.com", subject: "Hi", text: `Book ${link}`, html });
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="clg_[0-9a-f]{32}"/);
    expect(decodeParts(mime)).toEqual([`Book ${link}`, html]);
  });

  it("encodes non-ASCII subjects", () => {
    const mime = buildMimeMessage({ to: "a@example.com", subject: "Café trip", text: "x" });
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café trip").toString("base64")}?=`);
  });

  it("blocks header injection", () => {
    const mime = buildMimeMessage({ to: "a@example.com\r\nBcc: evil@example.com", subject: "x", text: "x" });
    expect(mime).not.toMatch(/\r\nBcc: evil/);
  });

  it("adds reply headers", () => {
    const mime = buildMimeMessage({ to: "a@example.com", subject: "Re: x", text: "x", inReplyTo: "<1@x>", references: "<0@x> <1@x>" });
    expect(mime).toContain("In-Reply-To: <1@x>");
    expect(mime).toContain("References: <0@x> <1@x>");
  });

  it("round-trips through base64url", () => {
    const raw = buildRawMessage({ to: "a@example.com", subject: "Hi", text: "x" });
    expect(raw).not.toMatch(/[+/=]/);
    expect(fromBase64Url(raw)).toContain("Subject: Hi");
  });
});

describe("prepareBodies", () => {
  it("requires a body", () => {
    expect(() => prepareBodies({})).toThrow(/needs a body/);
  });

  it("cleans both bodies and reports every cleaned link", () => {
    const wrapped = "https://www.google.com/url?q=https://calendly.com/example&source=gmail&ust=1793890030681000&sa=E";
    const result = prepareBodies({
      body: `Book: ${wrapped}`,
      html_body: `<a href="${wrapped.replace(/&/g, "&amp;")}">here</a>`,
    });
    expect(result.text).toBe("Book: https://calendly.com/example");
    expect(result.html).toBe('<a href="https://calendly.com/example">here</a>');
    expect(result.cleaned).toHaveLength(2);
  });

  it("makes a plain-text version when only HTML is given", () => {
    const result = prepareBodies({ html_body: '<p>Book <a href="https://calendly.com/example">here</a>.</p>' });
    expect(result.text).toBe("Book here (https://calendly.com/example).");
  });
});

describe("helpers", () => {
  it("converts HTML links to text sensibly", () => {
    expect(htmlToText('<a href="mailto:a@b.com">a@b.com</a>')).toBe("a@b.com");
    expect(htmlToText('<a href="https://x.com">https://x.com</a>')).toBe("https://x.com");
    expect(htmlToText("a<br>b &amp; c")).toBe("a\nb & c");
  });

  it("lists links from both bodies", () => {
    const links = listLinks("see https://x.com.", '<a href="https://y.com/?a=1&amp;b=2">Y</a>');
    expect(links).toEqual([
      { target: "https://x.com", found_in: "plain text" },
      { target: "https://y.com/?a=1&b=2", visible_text: "Y", found_in: "formatted" },
    ]);
  });

  it("splits address lists with quoted commas", () => {
    expect(splitAddresses('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual(['"Doe, Jane" <jane@x.com>', "bob@y.com"]);
    expect(emailOf('"Doe, Jane" <Jane@X.com>')).toBe("jane@x.com");
  });
});
