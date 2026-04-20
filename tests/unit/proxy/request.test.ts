import { describe, expect, test } from "bun:test";
import {
  isOrphanedToolResultError,
  extractOrphanedToolUseIds,
  removeOrphanedToolResults,
} from "../../../src/proxy/request";

describe("Request Utilities", () => {
  describe("isOrphanedToolResultError", () => {
    test("returns true for 400 with unexpected tool_use_id", () => {
      expect(isOrphanedToolResultError(400, "unexpected tool_use_id found")).toBe(true);
    });
    test("returns false for 200", () => {
      expect(isOrphanedToolResultError(200, "unexpected tool_use_id")).toBe(false);
    });
    test("returns false for 400 without matching text", () => {
      expect(isOrphanedToolResultError(400, "some other error")).toBe(false);
    });
    test("returns false for 500", () => {
      expect(isOrphanedToolResultError(500, "unexpected tool_use_id")).toBe(false);
    });
  });

  describe("extractOrphanedToolUseIds", () => {
    test("extracts single ID", () => {
      const ids = extractOrphanedToolUseIds("unexpected tool_use_id: toolu_abc123");
      expect(ids).toEqual(["toolu_abc123"]);
    });
    test("extracts multiple IDs", () => {
      const ids = extractOrphanedToolUseIds("ids: toolu_abc123, toolu_def456");
      expect(ids).toContain("toolu_abc123");
      expect(ids).toContain("toolu_def456");
      expect(ids.length).toBe(2);
    });
    test("deduplicates IDs", () => {
      const ids = extractOrphanedToolUseIds("toolu_abc toolu_abc");
      expect(ids).toEqual(["toolu_abc"]);
    });
    test("returns empty for no matches", () => {
      expect(extractOrphanedToolUseIds("no ids here")).toEqual([]);
    });
  });

  describe("removeOrphanedToolResults", () => {
    test("removes matching tool_result blocks", () => {
      const messages = [
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_abc", content: "result" },
          { type: "text", text: "hello" },
        ]},
      ];
      const cleaned = removeOrphanedToolResults(messages, ["toolu_abc"]);
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].content.length).toBe(1);
      expect(cleaned[0].content[0].type).toBe("text");
    });

    test("removes entire user message if empty after cleanup", () => {
      const messages = [
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_abc", content: "result" },
        ]},
      ];
      const cleaned = removeOrphanedToolResults(messages, ["toolu_abc"]);
      expect(cleaned.length).toBe(0);
    });

    test("preserves messages without tool_result", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      const cleaned = removeOrphanedToolResults(messages, ["toolu_abc"]);
      expect(cleaned.length).toBe(2);
    });

    test("handles empty messages array", () => {
      expect(removeOrphanedToolResults([], ["toolu_abc"])).toEqual([]);
    });

    test("handles multiple orphaned IDs", () => {
      const messages = [
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "r1" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "r2" },
          { type: "text", text: "hi" },
        ]},
      ];
      const cleaned = removeOrphanedToolResults(messages, ["toolu_a", "toolu_b"]);
      expect(cleaned[0].content.length).toBe(1);
      expect(cleaned[0].content[0].type).toBe("text");
    });
  });
});
