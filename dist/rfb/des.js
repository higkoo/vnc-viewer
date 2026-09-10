"use strict";
/**
 * 纯 JavaScript DES 实现（ECB 模式）
 *
 * 为什么不用 node:crypto？
 * Node 17+ 使用 OpenSSL 3，DES 属于 legacy provider，默认被禁用，
 * `crypto.createCipheriv('des-ecb', ...)` 会抛 ERR_OSSL_EVP_UNSUPPORTED。
 * VNC 认证只依赖 DES，因此这里自带一份无依赖实现，保证 Electron 各版本都能用。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.desEcbEncrypt = desEcbEncrypt;
// ---- 置换表 ----
/** 初始置换 IP */
const IP = [
    58, 50, 42, 34, 26, 18, 10, 2,
    60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6,
    64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17, 9, 1,
    59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5,
    63, 55, 47, 39, 31, 23, 15, 7,
];
/** 逆初始置换 FP (IP^-1) */
const FP = [
    40, 8, 48, 16, 56, 24, 64, 32,
    39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30,
    37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28,
    35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26,
    33, 1, 41, 9, 49, 17, 57, 25,
];
/** 扩展置换 E (32 -> 48) */
const E = [
    32, 1, 2, 3, 4, 5,
    4, 5, 6, 7, 8, 9,
    8, 9, 10, 11, 12, 13,
    12, 13, 14, 15, 16, 17,
    16, 17, 18, 19, 20, 21,
    20, 21, 22, 23, 24, 25,
    24, 25, 26, 27, 28, 29,
    28, 29, 30, 31, 32, 1,
];
/** P 置换 (32 -> 32) */
const P = [
    16, 7, 20, 21, 29, 12, 28, 17,
    1, 15, 23, 26, 5, 18, 31, 10,
    2, 8, 24, 14, 32, 27, 3, 9,
    19, 13, 30, 6, 22, 11, 4, 25,
];
/** 密钥置换 PC1 (64 -> 56) */
const PC1 = [
    57, 49, 41, 33, 25, 17, 9,
    1, 58, 50, 42, 34, 26, 18,
    10, 2, 59, 51, 43, 35, 27,
    19, 11, 3, 60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15,
    7, 62, 54, 46, 38, 30, 22,
    14, 6, 61, 53, 45, 37, 29,
    21, 13, 5, 28, 20, 12, 4,
];
/** 密钥置换 PC2 (56 -> 48) */
const PC2 = [
    14, 17, 11, 24, 1, 5,
    3, 28, 15, 6, 21, 10,
    23, 19, 12, 4, 26, 8,
    16, 7, 27, 20, 13, 2,
    41, 52, 31, 37, 47, 55,
    30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53,
    46, 42, 50, 36, 29, 32,
];
/** 每轮左移位数 */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
/** S 盒 (8 x 4 x 16) */
const SBOXES = [
    [[14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
        [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
        [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
        [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13]],
    [[15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
        [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
        [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
        [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9]],
    [[10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
        [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
        [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
        [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12]],
    [[7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
        [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
        [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
        [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14]],
    [[2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
        [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
        [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
        [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3]],
    [[12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
        [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
        [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
        [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13]],
    [[4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
        [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
        [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
        [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12]],
    [[13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
        [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
        [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
        [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]],
];
/** 将 n 字节缓冲区展开为 bit 数组（MSB first） */
function bytesToBits(buf, bytes) {
    const bits = new Array(bytes * 8);
    for (let i = 0; i < bytes; i++) {
        const b = buf[i];
        for (let j = 0; j < 8; j++) {
            bits[i * 8 + j] = (b >> (7 - j)) & 1;
        }
    }
    return bits;
}
/** 将 bit 数组打包成字节（每 8 位一字节，MSB first） */
function bitsToBytes(bits) {
    const out = Buffer.alloc(bits.length / 8);
    for (let i = 0; i < out.length; i++) {
        let b = 0;
        for (let j = 0; j < 8; j++) {
            b = (b << 1) | bits[i * 8 + j];
        }
        out[i] = b;
    }
    return out;
}
/** 按置换表重排（表中编号从 1 开始） */
function permute(bits, table) {
    const out = new Array(table.length);
    for (let i = 0; i < table.length; i++) {
        out[i] = bits[table[i] - 1];
    }
    return out;
}
/** 循环左移 n 位 */
function rotateLeft(bits, n) {
    return bits.slice(n).concat(bits.slice(0, n));
}
/** 异或两个等长 bit 数组 */
function xorBits(a, b) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++)
        out[i] = a[i] ^ b[i];
    return out;
}
/** 生成 16 个 48 位子密钥 */
function createSubKeys(key) {
    const keyBits = permute(bytesToBits(key, 8), PC1);
    let c = keyBits.slice(0, 28);
    let d = keyBits.slice(28);
    const subKeys = [];
    for (let round = 0; round < 16; round++) {
        c = rotateLeft(c, SHIFTS[round]);
        d = rotateLeft(d, SHIFTS[round]);
        subKeys.push(permute(c.concat(d), PC2));
    }
    return subKeys;
}
/** DES 单块加密（8 字节 -> 8 字节） */
function encryptBlock(block, subKeys) {
    const bits = permute(bytesToBits(block, 8), IP);
    let l = bits.slice(0, 32);
    let r = bits.slice(32);
    for (let round = 0; round < 16; round++) {
        const prevR = r;
        // f(R, K) = P(S(E(R) xor K))
        const expanded = permute(r, E);
        const xored = xorBits(expanded, subKeys[round]);
        const sOutput = [];
        for (let i = 0; i < 8; i++) {
            const chunk = xored.slice(i * 6, i * 6 + 6);
            const row = (chunk[0] << 1) | chunk[5];
            const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
            const value = SBOXES[i][row][col];
            for (let j = 3; j >= 0; j--)
                sOutput.push((value >> j) & 1);
        }
        const f = permute(sOutput, P);
        r = xorBits(l, f);
        l = prevR;
    }
    return bitsToBytes(permute(r.concat(l), FP));
}
/**
 * DES ECB 加密（无填充）
 * @param key  8 字节密钥
 * @param data 长度必须是 8 的倍数
 */
function desEcbEncrypt(key, data) {
    if (key.length !== 8) {
        throw new Error(`DES 密钥必须为 8 字节，当前 ${key.length} 字节`);
    }
    if (data.length === 0 || data.length % 8 !== 0) {
        throw new Error(`DES 数据长度必须是 8 的倍数，当前 ${data.length} 字节`);
    }
    const subKeys = createSubKeys(key);
    const out = Buffer.alloc(data.length);
    for (let offset = 0; offset < data.length; offset += 8) {
        encryptBlock(data.subarray(offset, offset + 8), subKeys).copy(out, offset);
    }
    return out;
}
//# sourceMappingURL=des.js.map