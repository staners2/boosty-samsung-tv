import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Vault {
  #path;
  #key;
  #writes = Promise.resolve();

  constructor(path, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Ключ хранилища должен содержать 32 байта');
    this.#path = path;
    this.#key = key;
  }

  async load() {
    let raw;
    try { raw = await readFile(this.#path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { sessions: {} }; throw error; }
    try {
      const encrypted = JSON.parse(raw);
      if (encrypted.version !== 1) throw new Error('Unsupported vault version');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(encrypted.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]);
      const result = JSON.parse(plain.toString('utf8'));
      if (!result.sessions || typeof result.sessions !== 'object' || Array.isArray(result.sessions)) throw new Error('Invalid sessions');
      return result;
    } catch { throw new Error('Не удалось расшифровать хранилище сессий: проверьте ключ и целостность файла'); }
  }

  save(data) {
    const plain = Buffer.from(JSON.stringify(data));
    const write = async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const payload = JSON.stringify({ version: 1, iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
      const temp = `${this.#path}.${randomBytes(12).toString('hex')}.tmp`;
      await writeFile(temp, payload, { mode: 0o600, flag: 'wx' });
      await rename(temp, this.#path);
    };
    const next = this.#writes.then(write, write);
    this.#writes = next;
    return next;
  }
}
