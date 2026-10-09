import { describe, expect, it } from "vitest";
import { filterSensitiveLines, isSensitiveText } from "../lib/redact";

describe("smart redact pattern detection", () => {
    it("detects email addresses inside sentences", () => {
        expect(isSensitiveText("contact me at dev@example.com")).toBe(true);
        expect(isSensitiveText("plain email like a @ b")).toBe(false);
    });

    it("detects card-like number sequences", () => {
        expect(isSensitiveText("4111 1111 1111 1111")).toBe(true);
        expect(isSensitiveText("version 1.2.3 build 4")).toBe(false);
    });

    it("detects Korean phone numbers and IDs", () => {
        expect(isSensitiveText("010-1234-5678")).toBe(true);
        expect(isSensitiveText("900101-1234567")).toBe(true);
        expect(isSensitiveText("2024-05-20")).toBe(false);
    });

    it("detects ipv4 addresses", () => {
        expect(isSensitiveText("server 192.168.0.1")).toBe(true);
    });

    it("detects JWT-like secrets", () => {
        expect(
            isSensitiveText(
                "token: eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
            ),
        ).toBe(true);
        expect(isSensitiveText("no secrets here")).toBe(false);
    });

    it("filters only matching OCR lines", () => {
        const lines = [
            { text: "hello world", box: [] },
            { text: "mail a@b.co", box: [] },
            { text: "call 010-1111-2222", box: [] },
        ];
        const hits = filterSensitiveLines(lines);
        expect(hits).toHaveLength(2);
        expect(hits[0].text).toBe("mail a@b.co");
    });
});
