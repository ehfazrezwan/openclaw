import { describe, expect, it } from "vitest";
import {
  assertRequiredParams,
  CLAUDE_PARAM_GROUPS,
  normalizeToolParams,
} from "./pi-tools.params.js";

const editGroups = CLAUDE_PARAM_GROUPS.edit;

describe("edit tool param validation", () => {
  describe("flat format (top-level oldText/newText)", () => {
    it("passes with canonical param names", () => {
      const params = { path: "file.ts", oldText: "foo", newText: "bar" };
      expect(() => assertRequiredParams(params, editGroups, "edit")).not.toThrow();
    });

    it("passes with alias param names", () => {
      const normalized = normalizeToolParams({
        file_path: "file.ts",
        old_string: "foo",
        new_string: "bar",
      });
      expect(() => assertRequiredParams(normalized, editGroups, "edit")).not.toThrow();
      expect(normalized).toMatchObject({ path: "file.ts", oldText: "foo", newText: "bar" });
    });

    it("passes when newText is empty (allowEmpty)", () => {
      const params = { path: "file.ts", oldText: "foo", newText: "" };
      expect(() => assertRequiredParams(params, editGroups, "edit")).not.toThrow();
    });
  });

  describe("nested edits array format", () => {
    it("passes when oldText/newText are inside edits array", () => {
      const params = {
        path: "file.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      };
      expect(() => assertRequiredParams(params, editGroups, "edit")).not.toThrow();
    });

    it("passes with multiple edits entries", () => {
      const params = {
        path: "file.ts",
        edits: [
          { oldText: "foo", newText: "bar" },
          { oldText: "baz", newText: "qux" },
        ],
      };
      expect(() => assertRequiredParams(params, editGroups, "edit")).not.toThrow();
    });

    it("passes when newText is empty inside edits (allowEmpty)", () => {
      const params = {
        path: "file.ts",
        edits: [{ oldText: "foo", newText: "" }],
      };
      expect(() => assertRequiredParams(params, editGroups, "edit")).not.toThrow();
    });
  });

  describe("alias normalization inside edits array", () => {
    it("normalizes old_string/new_string to oldText/newText inside edits", () => {
      const normalized = normalizeToolParams({
        file_path: "file.ts",
        edits: [{ old_string: "foo", new_string: "bar" }],
      });
      expect(normalized).toMatchObject({
        path: "file.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      });
      // Aliases should be removed after normalization
      const edits = normalized!.edits as Record<string, unknown>[];
      expect(edits[0]).not.toHaveProperty("old_string");
      expect(edits[0]).not.toHaveProperty("new_string");
    });

    it("normalized edits pass assertRequiredParams", () => {
      const normalized = normalizeToolParams({
        file_path: "file.ts",
        edits: [{ old_string: "foo", new_string: "bar" }],
      });
      expect(() => assertRequiredParams(normalized, editGroups, "edit")).not.toThrow();
    });
  });

  describe("missing params still fail", () => {
    it("throws when oldText and newText are missing everywhere", () => {
      const params = { path: "file.ts" };
      expect(() => assertRequiredParams(params, editGroups, "edit")).toThrow(
        /Missing required parameters: oldText alias, newText alias/,
      );
    });

    it("throws when edits array is empty", () => {
      const params = { path: "file.ts", edits: [] };
      expect(() => assertRequiredParams(params, editGroups, "edit")).toThrow(
        /Missing required parameters: oldText alias, newText alias/,
      );
    });

    it("throws when edits entries lack required fields", () => {
      const params = { path: "file.ts", edits: [{ unrelated: "value" }] };
      expect(() => assertRequiredParams(params, editGroups, "edit")).toThrow(
        /Missing required parameters: oldText alias, newText alias/,
      );
    });

    it("throws when path is missing", () => {
      const params = { edits: [{ oldText: "foo", newText: "bar" }] };
      expect(() => assertRequiredParams(params, editGroups, "edit")).toThrow(
        /Missing required parameter: path alias/,
      );
    });

    it("throws when record is undefined", () => {
      expect(() => assertRequiredParams(undefined, editGroups, "edit")).toThrow(
        /Missing parameters for edit/,
      );
    });
  });
});
