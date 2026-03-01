/**
 * @jest-environment jsdom
 */

const { countTokens, CONFIGS } = require("../src/content.js");

describe("Token Tracking Logic", () => {
    describe("countTokens", () => {
        it("should count zero for empty strings", () => {
            expect(countTokens("")).toBe(0);
            expect(countTokens("   ")).toBe(0);
            expect(countTokens(null)).toBe(0);
            expect(countTokens(undefined)).toBe(0);
        });

        it("should count tokens approximately as words * 1.3 ceil", () => {
            // 1 word -> 1.3 -> 2 tokens
            expect(countTokens("Hello")).toBe(2);
            // 2 words -> 2.6 -> 3 tokens
            expect(countTokens("Hello world")).toBe(3);
            // 4 words -> 5.2 -> 6 tokens
            expect(countTokens("This is a test")).toBe(6);
        });

        it("should ignore extra whitespace", () => {
            expect(countTokens("  Hello   world  ")).toBe(3);
        });
    });

    describe("Selectors configurations", () => {
        it("should have correct selectors for common AI platforms", () => {
            expect(CONFIGS["gemini.google.com"]).toBeDefined();
            expect(CONFIGS["chatgpt.com"]).toBeDefined();
            expect(CONFIGS["claude.ai"]).toBeDefined();
        });

        it("should use modernized selectors for claude.ai", () => {
            const claudeConf = CONFIGS["claude.ai"];
            expect(claudeConf.user).toContain('[data-testid="user-message"]');
            expect(claudeConf.ai).toContain('.font-claude-response');
        });

        it("should use modernized selectors for gemini.google.com", () => {
            const geminiConf = CONFIGS["gemini.google.com"];
            expect(geminiConf.user).toContain('.query-text');
        });
    });
});
