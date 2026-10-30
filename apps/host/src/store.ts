import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { digest, digestEqual, HttpError, secretEqual } from "./security.js";
import { isRecord } from "@codexphone/shared";

interface Device { id: string; name: string; tokenHash: string; createdAt: string; accountId?: string; sessionId?: string; installationId?: string; expiresAt?: number; permission?: "control" | "read"; blocked?: boolean; lastSeen?: string }
export class DeviceStore {
  private devices: Device[] = [];
  favorites = new Set<string>();
  private saves: Promise<void> = Promise.resolve();
  private pairing = { code: randomBytes(18).toString("base64url"), expiresAt: Date.now() + 10 * 60_000, failures: 0, consumed: false };
  constructor(readonly directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.directory, "devices.json"), "utf8"));
      if (!isRecord(value) || !Array.isArray(value.devices) || !Array.isArray(value.favorites)) throw new Error("Invalid device store");
      this.devices = value.devices.filter((entry): entry is Device => isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.tokenHash === "string" && /^[0-9a-f]{64}$/.test(entry.tokenHash) && typeof entry.createdAt === "string");
      this.favorites = new Set(value.favorites.filter((item): item is string => typeof item === "string"));
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") await this.save();
      else throw new Error("Could not read device store; preserve devices.json and fix it before restarting.");
    }
  }
  get pairingInfo(): { code: string; expiresAt: string } { return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() }; }
  renewPairing(): { code: string; expiresAt: string } {
    this.pairing = { code: randomBytes(18).toString("base64url"), expiresAt: Date.now() + 10 * 60_000, failures: 0, consumed: false };
    return this.pairingInfo;
  }
  authenticate(token: string | undefined): Device | undefined {
    const device = token ? this.devices.find((device) => digestEqual(device.tokenHash, digest(token)) && !device.blocked && (!device.expiresAt || device.expiresAt > Date.now())) : undefined;
    if (device) device.lastSeen = new Date().toISOString(); return device;
  }
  authorizedDevice(id: string): Device | undefined { return this.devices.find(device => device.id === id && !device.blocked && (!device.expiresAt || device.expiresAt > Date.now())); }
  hasDevice(id: string): boolean { const device = this.authorizedDevice(id); return !!device && device.permission !== "read"; }
  list(): Array<Omit<Device, "tokenHash">> { return this.devices.map(({ tokenHash: _secret, ...device }) => ({ ...device })); }
  async accountSession(identity: { accountId: string; sessionId: string; installationId: string; name: string; expiresAt: number }): Promise<{ token: string; deviceId: string }> {
    const existing = this.devices.find(device => device.accountId === identity.accountId && device.installationId === identity.installationId);
    if (existing?.blocked) throw new HttpError(403, "此手机已被电脑禁用，请在电脑连接管理中恢复权限");
    if (!existing && this.devices.length >= 32) throw new HttpError(409, "手机连接过多，请在电脑管理中心移除旧连接");
    const token = randomBytes(32).toString("base64url");
    const device: Device = existing || { id: randomUUID(), name: identity.name, tokenHash: "", createdAt: new Date().toISOString(), permission: "control" };
    Object.assign(device, identity, { tokenHash: digest(token), lastSeen: new Date().toISOString() });
    if (!existing) this.devices.push(device); await this.save(); return { token, deviceId: device.id };
  }
  async updatePermission(id: string, permission: unknown): Promise<void> {
    const device = this.devices.find(device => device.id === id); if (!device) throw new HttpError(404, "手机连接不存在");
    if (permission !== "control" && permission !== "read" && permission !== "blocked") throw new HttpError(400, "权限无效");
    device.blocked = permission === "blocked"; device.permission = permission === "read" ? "read" : "control"; await this.save();
  }
  async pair(code: unknown, name: unknown): Promise<{ token: string; deviceId: string }> {
    if (this.pairing.consumed || this.pairing.failures >= 8 || Date.now() > this.pairing.expiresAt) throw new HttpError(410, "Pairing code expired or used; generate another code on the computer");
    if (typeof code !== "string" || !secretEqual(code, this.pairing.code)) { this.pairing.failures++; throw new HttpError(401, "Invalid pairing code"); }
    if (this.devices.length >= 8) throw new HttpError(409, "Revoke an existing device on the computer before pairing another");
    this.pairing.consumed = true;
    const token = randomBytes(32).toString("base64url");
    const device = { id: randomUUID(), name: typeof name === "string" ? name.slice(0, 60) : "Phone", tokenHash: digest(token), createdAt: new Date().toISOString() };
    this.devices.push(device);
    await this.save();
    return { token, deviceId: device.id };
  }
  async revoke(id: string): Promise<void> { this.devices = this.devices.filter((device) => device.id !== id); await this.save(); }
  async favorite(id: string, pinned: boolean): Promise<void> { if (pinned) this.favorites.add(id); else this.favorites.delete(id); await this.save(); }
  private async save(): Promise<void> {
    const snapshot = JSON.stringify({ devices: this.devices, favorites: [...this.favorites] }, null, 2);
    const next = this.saves.catch(() => {}).then(async () => {
      const temporary = path.join(this.directory, `devices-${randomUUID()}.tmp`);
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, path.join(this.directory, "devices.json"));
    });
    this.saves = next; await next;
  }
}
