import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./security.js";

const scrypt = promisify(derive);
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
type Row = Record<string, string | number | null>;
export class AccountDatabase {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), installation TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, secret_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, installation TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);`);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS host_installation ON hosts(installation)");
  }
  async createUser(username: unknown, password: unknown) {
    const name = this.username(username); const secret = this.password(password);
    const salt = randomBytes(24).toString("hex"); const derived = await scrypt(secret, salt, 64) as Buffer;
    try { this.db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(randomUUID(), name, salt, derived.toString("hex")); }
    catch (e) { if (this.db.prepare("SELECT id FROM users WHERE username=?").get(name)) throw new HttpError(409, "此账号已存在，请登录"); throw e; }
  }
  async login(input: Record<string, unknown>) {
    const name = this.username(input.username);
    if (typeof input.password !== "string" || input.password.length > 256) throw new HttpError(401, "账号或密码不正确");
    const user = this.db.prepare("SELECT * FROM users WHERE username=?").get(name) as Row | undefined;
    const derived = await scrypt(input.password, user?.salt as string || "codexphone-missing-user", 64) as Buffer;
    if (!user || !timingSafeEqual(derived, Buffer.from(user.password_hash as string, "hex"))) throw new HttpError(401, "账号或密码不正确");
    const kind = input.kind === "desktop" ? "desktop" : input.kind === "web" ? "web" : "phone";
    const installation = this.installation(input.installationId);
    const deviceName = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "手机";
    const token = randomBytes(36).toString("base64url"), id = randomUUID(), expiresAt = Date.now() + (kind === "desktop" ? 8 * 3600_000 : 30 * 86400_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM sessions WHERE expires_at < ? OR (user_id=? AND installation=? AND kind=?)").run(Date.now(), user.id!, installation, kind);
      this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(id, user.id!, hash(token), kind, installation, deviceName, expiresAt);
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
    return { token, expiresAt, account: { id: user.id, username: name }, host: this.hostForUser(user.id as string) };
  }
  session(token: string): Row {
    const session = this.db.prepare("SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND expires_at>?").get(hash(token), Date.now()) as Row | undefined;
    if (!session) throw new HttpError(401, "登录已失效，请重新登录"); return session;
  }
  hostForUser(id: string) {
    const host = this.db.prepare("SELECT id,name,url FROM hosts WHERE user_id=?").get(id);
    return host || null;
  }
  bind(token: string, input: Record<string, unknown>, url: string) {
    const session = this.session(token);
    if (session.kind !== "desktop") throw new HttpError(403, "请在电脑端绑定工作站");
    const installation = this.installation(input.installationId);
    const existing = this.db.prepare("SELECT * FROM hosts WHERE user_id=?").get(session.user_id!) as Row | undefined;
    if (existing && (existing.installation !== installation || typeof input.previousHostSecret !== "string" || !this.secretMatches(existing.secret_hash as string, input.previousHostSecret)))
      throw new HttpError(409, "这个账号已经绑定另一台电脑，请先在原电脑解除绑定");
    const id = existing?.id as string || randomUUID(), secret = randomBytes(36).toString("base64url");
    const name = typeof input.name === "string" ? input.name.slice(0, 80) : "我的电脑";
    this.db.prepare("INSERT INTO hosts VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,url=excluded.url,secret_hash=excluded.secret_hash").run(id, session.user_id!, installation, name, url, hash(secret));
    return { id, name, url, secret, accountId: session.user_id, username: session.username };
  }
  authorize(hostId: string, secret: string, input: Record<string, unknown>) {
    const host = this.db.prepare("SELECT * FROM hosts WHERE id=?").get(hostId) as Row | undefined;
    if (!host || !this.secretMatches(host.secret_hash as string, secret)) throw new HttpError(401, "电脑授权已失效");
    const session = typeof input.token === "string" ? this.session(input.token) :
      this.db.prepare("SELECT * FROM sessions WHERE id=? AND expires_at>?").get(typeof input.sessionId === "string" ? input.sessionId : "", Date.now()) as Row | undefined;
    if (!session || session.user_id !== host.user_id || session.kind === "desktop") throw new HttpError(403, "此账号无权连接这台电脑");
    return { accountId: session.user_id as string, sessionId: session.id as string, installationId: session.installation as string,
      name: session.name as string, expiresAt: session.expires_at as number };
  }
  unbind(hostId: string, secret: string) {
    const host = this.db.prepare("SELECT secret_hash FROM hosts WHERE id=?").get(hostId) as Row | undefined;
    if (!host || !this.secretMatches(host.secret_hash as string, secret)) throw new HttpError(401, "电脑授权已失效");
    this.db.prepare("DELETE FROM hosts WHERE id=?").run(hostId);
  }
  logout(token: string) { this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token)); }
  close() { this.db.close(); }
  private secretMatches(expected: string, value: string) { return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hash(value), "hex")); }
  private username(value: unknown): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{3,64}$/.test(value.trim())) throw new HttpError(400, "账号使用 3–64 位字母、数字、点、下划线或短横线"); return value.trim().toLowerCase();
  }
  private password(value: unknown): string { if (typeof value !== "string" || value.length < 12 || value.length > 256) throw new HttpError(400, "密码需要 12–256 个字符"); return value; }
  private installation(value: unknown): string { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw new HttpError(400, "设备标识无效"); return value; }
}
