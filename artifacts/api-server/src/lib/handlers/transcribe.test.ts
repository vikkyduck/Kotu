import { test, expect, vi, beforeEach } from "vitest";
import type { Job } from "@workspace/db";

/**
 * Запись удалили, пока шла расшифровка: задача останавливается на ближайшей
 * границе куска и закрывается тихо — без платных запросов по остальным
 * кускам, без повтора и без «пробую ещё раз» в строку, которой уже нет.
 */

const state = vi.hoisted(() => ({
  alive: true,
  updates: [] as Record<string, unknown>[],
  handler: null as null | { run: (job: Job) => Promise<void> },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@workspace/db", () => {
  const rows = () => (state.alive ? [{ id: 5 }] : []);
  return {
    transcriptionsTable: { id: "id" },
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: 5, status: "processing" }] }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            state.updates.push(values);
            const result = rows();
            return Object.assign(Promise.resolve(result), { returning: async () => result });
          },
        }),
      }),
    },
  };
});
vi.mock("../jobs", () => ({
  registerHandler: (_kind: string, h: { run: (job: Job) => Promise<void> }) => {
    state.handler = h;
  },
}));
vi.mock("../transcript-doc", () => ({ syncTranscriptionDoc: vi.fn(async () => {}) }));
vi.mock("../archive", () => ({ archiveAndRemove: vi.fn(async () => {}) }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../paths", () => ({ UPLOAD_DIR: "/uploads" }));
vi.mock("../uploads", () => ({ resolveInsideDir: () => null }));

const secondChunk = vi.fn();
vi.mock("../transcription", () => ({
  ChunkError: class extends Error {},
  transcribeLongAudio: vi.fn(
    async (_p: string, _f: string, _o: unknown, onProgress: (p: object) => Promise<void>) => {
      await onProgress({ progress: 10, message: "Слушаю часть 1 из 2…" });
      state.alive = false; // DELETE /transcriptions/:id между кусками
      await onProgress({ progress: 51, message: "Слушаю часть 2 из 2…" });
      secondChunk();
      return [];
    },
  ),
}));

const { registerTranscribeHandler } = await import("./transcribe");
const { transcribeLongAudio } = await import("../transcription");
registerTranscribeHandler();

const job = {
  id: 1,
  kind: "transcribe",
  entityId: 5,
  payload: { inputPath: "/uploads/a", filename: "a.m4a", hideNames: false, markSpeakers: true },
} as unknown as Job;

beforeEach(() => {
  state.alive = true;
  state.updates = [];
  vi.mocked(transcribeLongAudio).mockClear();
  secondChunk.mockClear();
});

test("удалённая посреди работы запись: следующий кусок не распознаётся, задача закрыта тихо", async () => {
  await expect(state.handler!.run(job)).resolves.toBeUndefined();
  expect(secondChunk).not.toHaveBeenCalled();
  expect(state.updates.some((u) => u["statusMessage"] === "Не получилось, пробую ещё раз…")).toBe(
    false,
  );
});

test("удалённая до старта запись: расшифровка не начинается", async () => {
  state.alive = false;
  await expect(state.handler!.run(job)).resolves.toBeUndefined();
  expect(transcribeLongAudio).not.toHaveBeenCalled();
});
