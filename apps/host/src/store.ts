import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { digest, digestEqual, HttpError, secretEqual } from "./security.js";
import { isRecord } from "@codexphone/shared";

interface Device { id: string; name: string; tokenHash: string; createdAt: string }
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
  authenticate(token: string | undefined): Device | undefined { return token ? this.devices.find((device) => digestEqual(device.tokenHash, digest(token))) : undefined; }
  hasDevice(id: string): boolean { return this.devices.some((device) => device.id === id); }
  list(): Array<Omit<Device, "tokenHash">> { return this.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })); }
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
