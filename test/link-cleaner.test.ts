import { describe, expect, it } from "vitest";
import {
  BrokenRedirectError,
  cleanBody,
  containsRedirect,
  isGoogleRedirect,
  resolveRedirect,
} from "../src/link-cleaner.js";

const REAL = "https://calendly.com/example";
const WRAPPED = `https://www.google.com/url?q=${REAL}&source=gmail&ust=1793890030681000&sa=E`;

describe("resolveRedirect", () => {
  it("unwraps the standard Gmail wrapper", () => {
    expect(resolveRedirect(WRAPPED)).toBe(REAL);
  });

  it("unwraps a wrapper without www", () => {
    expect(resolveRedirect(`https://google.com/url?q=${REAL}&sa=D`)).toBe(REAL);
  });

  it("uses the url= parameter when q= is missing", () => {
    expect(resolveRedirect(`https://www.google.com/url?sa=t&url=${encodeURIComponent(REAL)}&usg=x`)).toBe(REAL);
  });

  it("decodes &amp; encoding", () => {
    expect(resolveRedirect(`https://www.google.com/url?q=${REAL}&amp;source=gmail&amp;sa=E`)).toBe(REAL);
  });

  it("decodes a percent-encoded target with its own query string", () => {
    const target = "https://www.example.com/?utm_source=email&ref=a%20b#contact";
    const wrapper = `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=E`;
    expect(resolveRedirect(wrapper)).toBe(target);
  });

  it("decodes a target that was percent-encoded twice", () => {
    const wrapper = `https://www.google.com/url?q=${encodeURIComponent(encodeURIComponent(REAL))}&sa=E`;
    expect(resolveRedirect(wrapper)).toBe(REAL);
  });

  it("unwraps wrappers nested inside wrappers", () => {
    const inner = `https://www.google.com/url?q=${encodeURIComponent(REAL)}&sa=E`;
    const outer = `https://www.google.com/url?q=${encodeURIComponent(inner)}&sa=E`;
    const outermost = `https://google.com/url?q=${encodeURIComponent(outer)}&sa=E`;
    expect(resolveRedirect(outermost)).toBe(REAL);
  });

  it("rejects a wrapper with no target", () => {
    expect(() => resolveRedirect("https://www.google.com/url?source=gmail&sa=E")).toThrow(/no real link/);
  });

  it("rejects a non-web target", () => {
    expect(() => resolveRedirect("https://www.google.com/url?q=javascript:alert(1)&sa=E")).toThrow(/http or https/);
  });

  it("rejects a target that is not a full address", () => {
    expect(() => resolveRedirect("https://www.google.com/url?q=calendly.com&sa=E")).toThrow(/does not start/);
  });
});

describe("isGoogleRedirect", () => {
  it.each([
    "https://www.google.com/maps/place/Washington,+DC",
    "https://maps.google.com/url?q=https://x.com",
    "https://docs.google.com/document/d/abc/edit",
    "https://drive.google.com/file/d/abc/view",
    "https://www.google.com/search?q=https://x.com",
    "https://www.google.co.uk/url?q=https://x.com",
    "https://notgoogle.com/url?q=https://x.com",
    "https://www.google.com/urls?q=https://x.com",
  ])("does not treat %s as a wrapper", (url) => {
    expect(isGoogleRedirect(url)).toBe(false);
  });
});

describe("cleanBody (plain text)", () => {
  it("replaces the wrapper and reports it", () => {
    const result = cleanBody(`Book here: ${WRAPPED}`, "text");
    expect(result.value).toBe(`Book here: ${REAL}`);
    expect(result.cleaned).toEqual([{ original: WRAPPED, cleaned: REAL }]);
  });

  it("keeps a sentence-ending period outside the link", () => {
    expect(cleanBody(`Book at ${WRAPPED}.`, "text").value).toBe(`Book at ${REAL}.`);
  });

  it("keeps wrapping parentheses outside the link", () => {
    expect(cleanBody(`(see ${WRAPPED})`, "text").value).toBe(`(see ${REAL})`);
  });

  it("cleans a bare wrapper with no scheme", () => {
    expect(cleanBody(`go to www.google.com/url?q=${REAL}&sa=E now`, "text").value).toBe(`go to ${REAL} now`);
  });

  it("cleans several wrappers in one body", () => {
    const other = "https://tours.example.org/";
    const body = `${WRAPPED} and https://www.google.com/url?q=${other}&sa=E`;
    const result = cleanBody(body, "text");
    expect(result.value).toBe(`${REAL} and ${other}`);
    expect(result.cleaned).toHaveLength(2);
  });

  it("leaves text with no wrappers exactly as written", () => {
    const body = [
      "https://calendly.com/example",
      "https://tours.example.org/",
      "https://www.example.org/?utm_source=email&utm_medium=test&ref=a%20b#contact",
      "example.org",
      "www.example.org/tours",
      "https://www.google.com/maps/place/Lincoln+Memorial/@38.8893,-77.0502,17z",
      "mailto:someone@example.com tel:+15555550100",
      "Ends with a period https://calendly.com/example.",
    ].join("\n");
    const result = cleanBody(body, "text");
    expect(result.value).toBe(body);
    expect(result.cleaned).toEqual([]);
  });

  it("refuses to save when a wrapper cannot be decoded, naming the bad link", () => {
    const bad = "https://www.google.com/url?source=gmail&sa=E";
    expect(() => cleanBody(`Fine ${WRAPPED} but bad ${bad}`, "text")).toThrow(BrokenRedirectError);
    try {
      cleanBody(`bad ${bad}`, "text");
    } catch (error) {
      expect((error as BrokenRedirectError).links[0].link).toBe(bad);
      expect((error as Error).message).toContain(bad);
      expect((error as Error).message).toContain("NOT saved");
    }
  });
});

describe("cleanBody (HTML)", () => {
  it("cleans the link target and the visible text", () => {
    const html = `<a href="https://www.google.com/url?q=${REAL}&amp;source=gmail&amp;sa=E">${WRAPPED.replace(/&/g, "&amp;")}</a>`;
    const result = cleanBody(html, "html");
    expect(result.value).toBe(`<a href="${REAL}">${REAL}</a>`);
    expect(result.cleaned).toHaveLength(2);
  });

  it("HTML-escapes ampersands in the real link", () => {
    const target = "https://example.com/?a=1&b=2";
    const html = `<a href="https://www.google.com/url?q=${encodeURIComponent(target)}&amp;sa=E">here</a>`;
    expect(cleanBody(html, "html").value).toBe(`<a href="https://example.com/?a=1&amp;b=2">here</a>`);
  });

  it("handles single-quoted attributes", () => {
    const html = `<a href='https://www.google.com/url?q=${REAL}&sa=E'>here</a>`;
    expect(cleanBody(html, "html").value).toBe(`<a href='${REAL}'>here</a>`);
  });

  it("leaves real Google links alone", () => {
    const html =
      '<a href="https://www.google.com/maps/place/X">Map</a> ' +
      '<a href="https://docs.google.com/document/d/abc/edit">Doc</a> ' +
      '<a href="https://drive.google.com/file/d/abc/view">File</a>';
    expect(cleanBody(html, "html")).toEqual({ value: html, cleaned: [] });
  });
});

describe("containsRedirect", () => {
  it("detects wrappers and ignores normal links", () => {
    expect(containsRedirect(`x ${WRAPPED} y`)).toBe(true);
    expect(containsRedirect("https://www.google.com/maps/place/X")).toBe(false);
  });
});
