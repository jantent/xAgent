import assert from "node:assert/strict";
import test from "node:test";

import { loadKeypairFromSecret } from "../../src/execution/solana/signer-utils.js";

test("loadKeypairFromSecret 会拒绝非法 JSON 字节数组", () => {
  assert.throws(
    () => loadKeypairFromSecret("[256, 1, 2]"),
    /0 and 255/
  );
});
