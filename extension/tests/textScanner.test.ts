import { beforeEach, describe, expect, it } from "vitest";
import { scanVisibleTextForPii } from "../src/content/textScanner";

// jsdom does no layout: getBoundingClientRect() is all-zero and
// Range.getClientRects() returns nothing, so every region would be filtered
// out as unmeasurable. Stub both with plausible boxes so these tests
// exercise the walking/filtering logic rather than an unrelated jsdom gap.
beforeEach(() => {
  document.body.innerHTML = "";
  // Mirrors the real behaviour the visibility check depends on: an element
  // under a display:none ancestor has a zero-sized rect, even though its own
  // computed `display` is untouched (display is not inherited).
  Element.prototype.getBoundingClientRect = function (this: Element) {
    for (let el: Element | null = this; el; el = el.parentElement) {
      if ((el as HTMLElement).style?.display === "none") {
        return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} } as DOMRect;
      }
    }
    return { x: 0, y: 0, width: 200, height: 20, top: 0, left: 0, right: 200, bottom: 20, toJSON() {} } as DOMRect;
  };
  Range.prototype.getClientRects = function (this: Range) {
    const rect = { x: 10, y: 10, width: 120, height: 16, top: 10, left: 10, right: 130, bottom: 26, toJSON() {} } as DOMRect;
    return Object.assign([rect], { item: (i: number) => (i === 0 ? rect : null) }) as unknown as DOMRectList;
  };
});

describe("scanVisibleTextForPii", () => {
  it("redacts a rendered participant name that no form field ever held", () => {
    // The reported bug: a video call's name labels are plain text, so
    // extractFields() never saw them and the screenshot kept them legible.
    document.body.innerHTML = `<div class="xYz123"><span>Disha Chakraborty</span></div>`;
    const regions = scanVisibleTextForPii();
    expect(regions).toHaveLength(1);
    expect(regions[0].semanticType).toBe("name");
    expect(regions[0].bbox.width).toBeGreaterThan(0);
  });

  it("redacts a name it could not have guessed, on a markup hint", () => {
    document.body.innerHTML = `<div data-self-name="x"><span>swpnanil das</span></div>`;
    const regions = scanVisibleTextForPii();
    expect(regions.map((r) => r.semanticType)).toEqual(["name"]);
  });

  it("redacts shaped PII rendered as text, not just in fields", () => {
    document.body.innerHTML = `<p>Contact support@example.com or call 9876543210.</p>`;
    const regions = scanVisibleTextForPii();
    expect(regions.map((r) => r.semanticType).sort()).toEqual(["email", "phone"]);
  });

  it("leaves ordinary UI copy alone", () => {
    document.body.innerHTML = `
      <h1>Privacy Policy</h1>
      <p>You are presenting. Share just a tab instead.</p>
      <button>Stop presenting</button>
    `;
    expect(scanVisibleTextForPii()).toHaveLength(0);
  });

  it("skips script and style content", () => {
    document.body.innerHTML = `<script>var owner = "Disha Chakraborty";</script><style>/* Disha Chakraborty */</style>`;
    expect(scanVisibleTextForPii()).toHaveLength(0);
  });

  it("skips hidden text, which is not in the screenshot to begin with", () => {
    document.body.innerHTML = `<div style="display:none"><span>Disha Chakraborty</span></div>`;
    expect(scanVisibleTextForPii()).toHaveLength(0);
  });

  it("does not re-cover form-field values that redactor.ts already tokenizes", () => {
    document.body.innerHTML = `<textarea>Disha Chakraborty</textarea><select><option>Disha Chakraborty</option></select>`;
    expect(scanVisibleTextForPii()).toHaveLength(0);
  });

  it("reports one region per line for text that wraps", () => {
    Range.prototype.getClientRects = function (this: Range) {
      const rects = [
        { x: 10, y: 10, width: 60, height: 16, top: 10, left: 10, right: 70, bottom: 26, toJSON() {} },
        { x: 0, y: 26, width: 40, height: 16, top: 26, left: 0, right: 40, bottom: 42, toJSON() {} },
      ] as DOMRect[];
      return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
    };
    document.body.innerHTML = `<span>Disha Chakraborty</span>`;
    // One union box would black out whatever sits beside the wrap.
    expect(scanVisibleTextForPii()).toHaveLength(2);
  });

  it("reaches text inside an open shadow root", () => {
    // TreeWalker stops at a shadow boundary, so a page that renders its
    // content in web components would report a confident, wrong zero.
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<span>Disha Chakraborty</span>`;
    expect(scanVisibleTextForPii().map((r) => r.semanticType)).toEqual(["name"]);
  });

  it("reaches text nested several shadow roots deep", () => {
    document.body.innerHTML = `<div id="outer"></div>`;
    const outer = document.getElementById("outer")!;
    const outerShadow = outer.attachShadow({ mode: "open" });
    outerShadow.innerHTML = `<div id="inner"></div>`;
    const inner = outerShadow.getElementById("inner")!;
    inner.attachShadow({ mode: "open" }).innerHTML = `<span>Aishiki Podder</span>`;
    expect(scanVisibleTextForPii().map((r) => r.semanticType)).toEqual(["name"]);
  });

  it("emits regions with no element id, since text nodes are not elements", () => {
    document.body.innerHTML = `<span>Disha Chakraborty</span>`;
    expect(scanVisibleTextForPii()[0].elementId).toBeNull();
  });
});
