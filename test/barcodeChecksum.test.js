import test from "node:test";
import assert from "node:assert/strict";

// Mirror of media.js export (media.js imports wasm, so it can't load under node:test)
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/media.js", import.meta.url), "utf8");
const fnSrc = src.slice(src.indexOf("export function isValidGs1Barcode")).replace("export ", "");
const isValidGs1Barcode = new Function(fnSrc + "; return isValidGs1Barcode;")();

test("accepts valid barcodes", () => {
  assert.equal(isValidGs1Barcode("4006381333931"), true); // EAN-13
  assert.equal(isValidGs1Barcode("036000291452"), true); // UPC-A
  assert.equal(isValidGs1Barcode("96385074"), true); // EAN-8
});
test("rejects bad check digit, bad length, non-digits", () => {
  assert.equal(isValidGs1Barcode("4006381333932"), false);
  assert.equal(isValidGs1Barcode("5995750112"), false); // the 10-digit misread
  assert.equal(isValidGs1Barcode("abc"), false);
  assert.equal(isValidGs1Barcode(""), false);
});
