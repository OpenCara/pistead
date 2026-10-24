import test from "node:test";
import assert from "node:assert/strict";
import { chatImageLimits, messageHash, parseChatImages } from "../packages/shared/src/chat-images.js";
import { sha256 } from "../packages/shared/src/crypto.js";

const image = { mimeType: "image/png", data: "iVBORw0KGgo=" };

test("a message's images are checked for shape, type and size before they go anywhere", () => {
  assert.deepEqual(parseChatImages([image]), { images: [image] });
  assert.deepEqual(parseChatImages([]), { images: [] });
  for (const value of [undefined, null, {}, "image", [null], [[]], [{ ...image, name: "screenshot.png" }], [{ data: image.data }]]) {
    assert.ok("error" in parseChatImages(value), JSON.stringify(value));
  }
  assert.match((parseChatImages(Array(chatImageLimits.count + 1).fill(image)) as { error: string }).error, /at most 4 images/);
  assert.match((parseChatImages([{ ...image, mimeType: "image/svg+xml" }]) as { error: string }).error, /PNG, JPEG, GIF or WebP/);
  for (const data of ["", "abc", "a b=", "abcd=", "ab==cd==", "data:image/png;base64,iVBORw0KGgo="]) {
    assert.ok("error" in parseChatImages([{ ...image, data }]), data);
  }
  const largest = "A".repeat(chatImageLimits.imageBase64);
  assert.deepEqual(parseChatImages([{ ...image, data: largest }]), { images: [{ ...image, data: largest }] });
  assert.match((parseChatImages([{ ...image, data: `${largest}AAAA` }]) as { error: string }).error, /512 KiB/);
  // Each within its own bound, together over the message's.
  assert.match((parseChatImages([{ ...image, data: largest }, { ...image, data: largest }]) as { error: string }).error, /720 KiB together/);
});

test("a message's idempotency hash is its text's alone without images, and binds its images when it has some", async () => {
  assert.equal(await messageHash("hello"), await sha256("hello"));
  assert.equal(await messageHash("hello", []), await sha256("hello"));
  const one = await messageHash("hello", [{ mimeType: "image/png", data: "AAAA" }]);
  assert.notEqual(one, await sha256("hello"));
  assert.notEqual(one, await messageHash("hello", [{ mimeType: "image/jpeg", data: "AAAA" }]));
  assert.notEqual(one, await messageHash("hello", [{ mimeType: "image/png", data: "AAAB" }]));
  assert.notEqual(await messageHash("", [{ mimeType: "image/png", data: "AAAA" }, { mimeType: "image/png", data: "BBBB" }]),
    await messageHash("", [{ mimeType: "image/png", data: "BBBB" }, { mimeType: "image/png", data: "AAAA" }]));
});
