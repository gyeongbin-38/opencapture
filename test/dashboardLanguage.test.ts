import { describe, expect, it } from "vitest";
import {
    dashboardLanguageDirection,
    dashboardLanguageSettings,
    validateDashboardLanguage,
} from "../lib/dashboardLanguage";

const supported = [
    "zh-HANS",
    "ar",
    "en",
    "eo",
    "es",
    "fr",
    "ko",
    "ru",
    "zh-HANT",
] as const;

describe("dashboard language settings", () => {
    it("accepts only exact supported catalog identifiers", () => {
        expect(validateDashboardLanguage("ko", supported)).toBe("ko");
        expect(validateDashboardLanguage("zh-HANT", supported)).toBe("zh-HANT");
        for (const value of ["en-US", "../en", "<script>", "", null, {}])
            expect(() => validateDashboardLanguage(value, supported)).toThrow(
                "지원하지 않는 언어입니다.",
            );
    });

    it("keeps active and configured languages separate until next launch", () => {
        expect(
            dashboardLanguageSettings("ko", "en", [
                { value: "ko", name: "한국어" },
                { value: "en", name: "English" },
            ]),
        ).toEqual({
            active: "ko",
            configured: "en",
            pending: true,
            applies: "next-launch",
            options: [
                { value: "ko", name: "한국어" },
                { value: "en", name: "English" },
            ],
        });
    });

    it("uses RTL only for the Arabic catalog", () => {
        expect(dashboardLanguageDirection("ar")).toBe("rtl");
        expect(dashboardLanguageDirection("ko")).toBe("ltr");
        expect(dashboardLanguageDirection("en")).toBe("ltr");
    });
});
