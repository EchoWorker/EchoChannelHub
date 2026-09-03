export interface ReplyBudgetOptions {
  ttlMs?: number;
  maxScenes?: number;
  maxReplies?: number;
  now?: () => number;
}

export interface ReplyReservation {
  readonly token: string;
  readonly scene: string;
  readonly msgId: string;
  readonly msgSeq: number;
}

interface Scene {
  expiresAt: number;
  committed: number;
  nextSeq: number;
  reservations: Map<string, number>;
  freeSeq: number[];
}

export class ReplyBudget {
  private readonly scenes = new Map<string, Scene>();
  private serial = 0;
  private readonly ttlMs: number;
  private readonly maxScenes: number;
  private readonly maxReplies: number;
  private readonly now: () => number;

  constructor(options: ReplyBudgetOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxScenes = options.maxScenes ?? 10_000;
    this.maxReplies = options.maxReplies ?? 5;
    this.now = options.now ?? Date.now;
    if (this.ttlMs <= 0 || this.maxScenes <= 0 || this.maxReplies <= 0) throw new Error("reply budget limits must be positive");
  }

  reserve(scene: string, msgId: string): ReplyReservation {
    if (!scene || !msgId) throw new Error("scene and msgId are required for passive replies");
    this.prune();
    let state = this.scenes.get(scene);
    if (!state) {
      while (this.scenes.size >= this.maxScenes) this.scenes.delete(this.scenes.keys().next().value!);
      state = { expiresAt: this.now() + this.ttlMs, committed: 0, nextSeq: 1, reservations: new Map(), freeSeq: [] };
      this.scenes.set(scene, state);
    }
    if (state.committed + state.reservations.size >= this.maxReplies) throw new Error(`QQ reply budget exhausted: ${scene}`);
    const token = `${++this.serial}:${scene}`;
    const msgSeq = state.freeSeq.shift() ?? state.nextSeq++;
    state.reservations.set(token, msgSeq);
    state.expiresAt = this.now() + this.ttlMs;
    return { token, scene, msgId, msgSeq };
  }

  commit(reservation: ReplyReservation): void {
    const state = this.requireReservation(reservation);
    state.reservations.delete(reservation.token);
    state.committed += 1;
    state.expiresAt = this.now() + this.ttlMs;
  }

  rollback(reservation: ReplyReservation): void {
    const state = this.requireReservation(reservation);
    const seq = state.reservations.get(reservation.token)!;
    state.reservations.delete(reservation.token);
    state.freeSeq.push(seq);
    state.freeSeq.sort((a, b) => a - b);
  }

  private requireReservation(reservation: ReplyReservation): Scene {
    const state = this.scenes.get(reservation.scene);
    if (!state || state.reservations.get(reservation.token) !== reservation.msgSeq) {
      throw new Error("invalid or completed reply reservation");
    }
    return state;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, state] of this.scenes) if (state.expiresAt <= now) this.scenes.delete(key);
  }
}
