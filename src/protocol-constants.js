// SPDX-License-Identifier: GPL-3.0-only
// Adapted from jixunmoe/qmweb-sign 2.0.3 (MIT), commit 15305a3cc39f80eb1646ab2bae46468231765736.
// Public client wire constants, not account credentials. Full permission notice: NOTICE.
export const PUBLIC_AG1 = Object.freeze({
  aesKey: new Uint8Array([189, 48, 95, 16, 208, 255, 116, 182, 239, 84, 218, 184, 53, 181, 225, 207]),
  signMask: new Uint8Array([89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]),
  responseMask: new Uint8Array([122, 63, 140, 29, 94, 155, 47, 10, 108, 77, 126, 139, 31, 58, 92, 157, 14, 43, 111, 74, 129]),
  firstIndexes: [23, 14, 6, 36, 16, 40, 7, 19],
  lastIndexes: [16, 1, 32, 12, 19, 27, 8, 5],
});
