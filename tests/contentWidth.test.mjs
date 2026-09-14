import test from "node:test";
import assert from "node:assert/strict";
import { parseContentWidth } from "../src/contentWidth.ts";

test("content width preference defaults to default when storage is missing or invalid", () => {
  assert.equal(parseContentWidth(null), "default");
  assert.equal(parseContentWidth("wide"), "default");
});

test("content width preference preserves the supported full-width selection", () => {
  assert.equal(parseContentWidth("full"), "full");
});
