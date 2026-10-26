import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  boardEvidence,
  emptyProfile,
  enqueueEvidence,
  profileSchema,
  rewritePrompt,
  shouldRewrite,
  type ProfileEvent,
  type UserProfile,
} from "../src/shared/profile.js";
import type { Board } from "../src/shared/types.js";

/** File mutations are serialized; model calls run outside that queue so reads/saves stay responsive. */
export class ProfileStore {
  private profile = emptyProfile();
  private queue: Promise<unknown> = Promise.resolve();
  private rewriting = false;
  private immediate = false;
  constructor(
    private file: string,
    private rewrite: (prompt: string) => Promise<string>,
    private changed: (profile: UserProfile) => void = () => {},
  ) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => undefined);
    return task;
  }
  async initialize(boards: () => Promise<Board[]>): Promise<void> {
    let missing = false;
    await this.serial(async () => {
      try {
        this.profile = profileSchema.parse(
          JSON.parse(await readFile(this.file, "utf8")),
        );
      } catch (error) {
        missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!missing)
          await rename(this.file, `${this.file}.corrupt-${randomUUID()}`);
        this.profile = emptyProfile();
        if (missing)
          this.profile = enqueueEvidence(
            this.profile,
            (await boards()).flatMap((b) => boardEvidence(b)),
          );
        await this.persist();
      }
    });
    this.kick(missing ? "probe" : "startup");
  }
  async get(): Promise<UserProfile> {
    await this.queue;
    return structuredClone(this.profile);
  }
  async enqueue(events: ProfileEvent[]): Promise<void> {
    if (!events.length) return;
    await this.serial(async () => {
      this.profile = enqueueEvidence(this.profile, events);
      await this.persist();
    });
    this.kick(events.some((e) => e.kind === "probe") ? "probe" : "queue");
  }
  private kick(trigger: "probe" | "queue" | "startup") {
    if (!shouldRewrite(this.profile, trigger)) return;
    if (this.rewriting) {
      if (trigger === "probe") this.immediate = true;
      return;
    }
    this.rewriting = true;
    const batch = structuredClone(this.profile.pending);
    const prompt = rewritePrompt(this.profile, batch);
    void this.rewrite(prompt)
      .then((text) =>
        this.serial(async () => {
          const clean = text.trim();
          if (
            !clean ||
            clean.length > 500 ||
            /[\r\n]|^\s*(?:[\[{#*]|-\s|\d+[.、])/.test(clean)
          )
            throw new Error("Invalid profile prose");
          const time = new Date().toISOString();
          const next = {
            ...this.profile,
            text: clean,
            updatedAt: time,
            lastRewriteAt: time,
            pending: this.profile.pending.filter(
              (e) => !batch.some((b) => b.id === e.id && b.detail === e.detail),
            ),
          };
          const previous = this.profile;
          this.profile = next;
          try {
            await this.persist();
            this.changed(structuredClone(this.profile));
          } catch (error) {
            this.profile = previous;
            throw error;
          }
        }),
      )
      .then(() => {
        this.rewriting = false;
        const next = this.immediate ? "probe" : "queue";
        this.immediate = false;
        this.kick(next);
      })
      .catch(() => {
        this.rewriting = false;
        this.immediate = false;
      });
  }
  private async persist() {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.profile.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(profileSchema.parse(this.profile)));
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await file.close();
    try {
      await rename(temporary, this.file);
      const directory = await open(dir, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
