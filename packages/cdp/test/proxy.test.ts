import { describe, expect, test } from "bun:test";
import { parseSubjects } from "../src/proxy";

describe("parseSubjects", () => {
  test("self first, then deduped proxies with names + eids", () => {
    const raw = JSON.stringify({
      self: "Alex",
      links: [
        { href: "/MyChart/inside.asp?mode=proxyswitch&action=switchcontext&src=0&eid=EID_ROBIN", label: "Access Robin's record Last person in list" },
        { href: "/MyChart/inside.asp?mode=proxyswitch&action=switchcontext&src=0&eid=EID_ROBIN", label: "Access Robin's record" }, // dup
        { href: "/MyChart/inside.asp?mode=proxyswitch&action=switchcontext&src=0&eid=EID_SAM", label: "Access Sam's record" },
      ],
    });
    const s = parseSubjects(raw);
    expect(s[0]).toEqual({ name: "Alex", eid: "", isSelf: true });
    expect(s.slice(1)).toEqual([
      { name: "Robin", eid: "EID_ROBIN", isSelf: false },
      { name: "Sam", eid: "EID_SAM", isSelf: false },
    ]);
  });

  test("handles &amp;-encoded hrefs and missing self", () => {
    const raw = JSON.stringify({
      self: "",
      links: [{ href: "x?eid=ABC&amp;redirecturl=Home", label: "Access Pat's record" }],
    });
    const s = parseSubjects(raw);
    expect(s[0].isSelf).toBe(true);
    expect(s[0].name).toBe("self");
    expect(s[1]).toEqual({ name: "Pat", eid: "ABC", isSelf: false });
  });

  test("garbage input degrades to self-only", () => {
    expect(parseSubjects("not json")).toEqual([{ name: "self", eid: "", isSelf: true }]);
  });
});
