import { describe, expect, test } from "bun:test";
import { embeddedMyChartHome } from "../src/detect";

describe("embeddedMyChartHome", () => {
  const outer = "https://myhealth.example.org/signedin/";
  test("portal wrapping MyChart in a cross-origin iframe → the app's Home", () => {
    expect(embeddedMyChartHome(["https://mychart.example.org/myhealth_sso/inside.asp"], outer)).toBe(
      "https://mychart.example.org/myhealth_sso/Home/",
    );
  });
  test("root-served app and bare inside.asp have no prefix", () => {
    expect(embeddedMyChartHome(["https://mychart.example.org/"], outer)).toBe("https://mychart.example.org/Home/");
    expect(embeddedMyChartHome(["https://chart.example.org/inside.asp?x=1"], outer)).toBe(
      "https://chart.example.org/Home/",
    );
  });
  test("same-origin frame under a different prefix counts; relative srcs resolve", () => {
    expect(embeddedMyChartHome(["/MyChart/inside.asp"], outer)).toBe("https://myhealth.example.org/MyChart/Home/");
  });
  test("never copies query/hash; refuses other sites, lookalikes, http, userinfo", () => {
    expect(
      embeddedMyChartHome(["https://mychart.example.org/sso/inside.asp?token=do-not-copy#private"], outer),
    ).toBe("https://mychart.example.org/sso/Home/");
    for (const src of [
      "https://mychart.elsewhere.test/MyChart/inside.asp",
      "https://mychart.example.org.elsewhere.test/MyChart/inside.asp",
      "https://mychart.example.org@elsewhere.test/MyChart/inside.asp",
      "https://user:pw@mychart.example.org/MyChart/inside.asp",
      "http://mychart.example.org/MyChart/inside.asp",
      "http://[",
    ]) {
      expect(embeddedMyChartHome([src], outer)).toBeNull();
    }
    expect(embeddedMyChartHome(["https://mychart.example.org/"], "invalid")).toBeNull();
  });
  test("ignores unrelated, non-http and self frames", () => {
    expect(
      embeddedMyChartHome(
        [
          "https://www.youtube.com/embed/abc",
          "https://video.example.org/embed/abc",
          "https://www.google.com/recaptcha/api2/anchor",
          "javascript:alert('mychart')",
          "about:blank",
          "",
        ],
        outer,
      ),
    ).toBeNull();
    expect(
      embeddedMyChartHome(["https://mychart.example.org/MyChart/inside.asp"], "https://mychart.example.org/MyChart/Home/"),
    ).toBeNull();
  });
});
