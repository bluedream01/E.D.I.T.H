import { beforeEach, describe, expect, it } from "vitest";
import { extractFields } from "../src/content/domExtractor";

// jsdom does no real layout, so getBoundingClientRect() is all-zero by
// default — extractFields()'s visibility check would filter out every
// element. Stub a plausible non-zero rect so these tests can exercise the
// actual extraction/id logic instead of failing on an unrelated jsdom gap.
beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, toJSON() {} }) as DOMRect;
});

describe("extractFields — id assignment", () => {
  it("assigns sequential, unique ids to new elements", () => {
    document.body.innerHTML = `
      <input id="a" type="email" />
      <button id="b">Click me</button>
    `;
    const fields = extractFields();
    const ids = fields.map((f) => f.elementId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reuses an element's existing data-pba-id instead of reassigning", () => {
    document.body.innerHTML = `<input id="a" type="email" data-pba-id="pba-7" />`;
    const [field] = extractFields();
    expect(field.elementId).toBe("pba-7");
  });

  it(
    "never collides with an id already present in the DOM, even simulating a " +
      "prior injection's leftover state (the actual bug: a module-level counter " +
      "reset to 0 on re-injection, handing out ids that already existed on the page)",
    () => {
      // Simulate elements tagged by a "previous injection" with high ids already
      // present in the DOM (as they would be, since attributes persist on the
      // page across content-script re-injections).
      document.body.innerHTML = `
        <input id="old1" type="email" data-pba-id="pba-1" />
        <input id="old2" type="text" data-pba-id="pba-5" />
        <button id="brandNew">New element that appeared since</button>
      `;
      const fields = extractFields();
      const newField = fields.find((f) => f.element.id === "brandNew")!;
      expect(newField).toBeDefined();
      // Must not collide with pba-1 or pba-5, which are "already live" on the page.
      expect(newField.elementId).not.toBe("pba-1");
      expect(newField.elementId).not.toBe("pba-5");
      const ids = fields.map((f) => f.elementId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  );
});

describe("extractFields — button type classification", () => {
  it("does not report inputType 'submit' for a <button> with no explicit type attribute", () => {
    // <button> without a type attribute reports .type === "submit" via the DOM
    // property getter by spec default — that's a real footgun this must not trust.
    document.body.innerHTML = `<button id="plain">Notifications</button>`;
    const [field] = extractFields();
    expect(field.field.inputType).toBeNull();
  });

  it("still reports inputType 'submit' when the attribute is explicitly set", () => {
    document.body.innerHTML = `<button id="s" type="submit">Register</button>`;
    const [field] = extractFields();
    expect(field.field.inputType).toBe("submit");
  });

  it("reports an explicit type=button attribute correctly", () => {
    document.body.innerHTML = `<button id="b" type="button">Cancel</button>`;
    const [field] = extractFields();
    expect(field.field.inputType).toBe("button");
  });
});

describe("extractFields — links", () => {
  it("extracts links, which the agent previously could not see at all", () => {
    // The selector covered inputs and buttons only, so a search result — an
    // <a> — produced no element, and "play the first result" had no target.
    document.body.innerHTML = `<a href="/watch?v=1">Imagine Dragons - Believer</a>`;
    const [field] = extractFields();
    expect(field.elementType).toBe("link");
    expect(field.field.rawValue).toBe("Imagine Dragons - Believer");
  });

  it("marks same-origin and off-site links apart", () => {
    document.body.innerHTML = `
      <a href="/watch?v=1">Internal</a>
      <a href="https://elsewhere.example/x">External</a>
    `;
    const [internal, external] = extractFields();
    expect(internal.field.__sameOrigin).toBe(true);
    expect(external.field.__sameOrigin).toBe(false);
  });

  it("treats non-navigating hrefs as staying put", () => {
    document.body.innerHTML = `<a href="#section">Jump</a><a href="javascript:void(0)">Noop</a>`;
    expect(extractFields().every((f) => f.field.__sameOrigin)).toBe(true);
  });

  it("skips text-less link wrappers, which spend the budget on nothing", () => {
    document.body.innerHTML = `<a href="/a"><img src="x.png" /></a><a href="/b">Real title</a>`;
    const fields = extractFields();
    expect(fields).toHaveLength(1);
    expect(fields[0].field.rawValue).toBe("Real title");
  });

  it("caps links so a link-heavy page cannot crowd out its own controls", () => {
    // The backend rejects a payload over 600 elements outright; a results
    // page carries several hundred links.
    document.body.innerHTML =
      Array.from({ length: 200 }, (_, i) => `<a href="/v${i}">Video ${i}</a>`).join("") +
      `<button>Search</button>`;
    const fields = extractFields();
    expect(fields.filter((f) => f.elementType === "link")).toHaveLength(120);
    expect(fields.some((f) => f.elementType === "button")).toBe(true);
  });

  it("still treats an anchor with role=button as a button", () => {
    document.body.innerHTML = `<a href="#" role="button">Subscribe</a>`;
    expect(extractFields()[0].elementType).toBe("button");
  });
});
