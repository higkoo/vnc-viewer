/**
 * 纯 JavaScript DES 实现（ECB 模式）
 *
 * 为什么不用 node:crypto？
 * Node 17+ 使用 OpenSSL 3，DES 属于 legacy provider，默认被禁用，
 * `crypto.createCipheriv('des-ecb', ...)` 会抛 ERR_OSSL_EVP_UNSUPPORTED。
 * VNC 认证只依赖 DES，因此这里自带一份无依赖实现，保证 Electron 各版本都能用。
 */
/**
 * DES ECB 加密（无填充）
 * @param key  8 字节密钥
 * @param data 长度必须是 8 的倍数
 */
export declare function desEcbEncrypt(key: Buffer, data: Buffer): Buffer;
//# sourceMappingURL=des.d.ts.map