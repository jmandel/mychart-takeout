import { describe, expect, test } from "bun:test";
import { embeddedMyChartUrl } from "../src/embedded";

const wrapper = "https://myhealth.stanfordhealthcare.org/signedin/";
const origin = "https://mychart.stanfordhealthcare.org";
const home = `${origin}/myhealth_sso/Home/`;

describe("Stanford embedded MyChart handoff", () => {
  test("returns the verified home route without iframe query or fragment", () => {
    expect(embeddedMyChartUrl(wrapper, [
      "about:blank",
      `${origin}/myhealth_sso/inside.asp?webservice=synthetic&token=do-not-copy#private`,
    ])).toBe(home);
    expect(embeddedMyChartUrl(wrapper, [home])).toBe(home);
  });

  test("requires the known wrapper and a recognized iframe", () => {
    for (const page of ["invalid", "https://example.org/signedin/", home,
      "http://myhealth.stanfordhealthcare.org/signedin/",
      "https://myhealth.stanfordhealthcare.org/"]) {
      expect(embeddedMyChartUrl(page, [home])).toBeNull();
    }
    expect(embeddedMyChartUrl(wrapper, [])).toBeNull();
  });

  test("ignores unrelated, unsafe, and lookalike iframe destinations", () => {
    for (const src of [
      "javascript:alert(1)", "data:text/html,test", "http://[",
      "/myhealth_sso/inside.asp",
      "http://mychart.stanfordhealthcare.org/myhealth_sso/inside.asp",
      "https://mychart.stanfordhealthcare.org.example.org/myhealth_sso/inside.asp",
      "https://mychart.stanfordhealthcare.org@elsewhere.example/myhealth_sso/inside.asp",
      "https://user:password@mychart.stanfordhealthcare.org/myhealth_sso/inside.asp",
      `${origin}:8443/myhealth_sso/inside.asp`,
      `${origin}/unrelated/inside.asp`,
      `${origin}/myhealth_sso/Authentication/Login`,
    ]) {
      expect(embeddedMyChartUrl(wrapper, [src])).toBeNull();
    }
  });
});
