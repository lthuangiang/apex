/**
 * Hàng chờ giá tốt nhất SoDEX theo market (DEC-248, DEC-298). Mỗi market tối đa một lần xử lý đang chạy;
 * tin tới trong lúc đó chỉ giữ tin mới nhất (tin cũ hơn bị bỏ), các market chạy song song. Giờ nhận được đóng dấu lúc
 * NATS giao tin, nên tin phải chờ không bị coi là mới hơn tuổi thật của nó.
 */
export class BookCoalescer<T> {
  readonly #handle: (msg: T, recvAt: number) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #pending = new Map<string, { msg: T; recvAt: number }>();
  readonly #running = new Set<string>();
  readonly #idle = new Set<() => void>();

  constructor(
    handle: (msg: T, recvAt: number) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.#handle = handle;
    this.#onError = onError;
  }

  /** Tin mới cho `key`, nhận lúc `recvAt`. Đang xử lý market này thì thay tin đang chờ (nếu có). */
  push(key: string, msg: T, recvAt: number): void {
    this.#pending.set(key, { msg, recvAt });
    if (!this.#running.has(key)) void this.#drain(key);
  }

  /** Chờ tới khi không còn tin nào đang xử lý hay đang chờ (cho test). */
  idle(): Promise<void> {
    if (this.#running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.add(resolve));
  }

  async #drain(key: string): Promise<void> {
    this.#running.add(key);
    try {
      for (let next = this.#pending.get(key); next !== undefined; next = this.#pending.get(key)) {
        this.#pending.delete(key);
        try {
          await this.#handle(next.msg, next.recvAt);
        } catch (error) {
          this.#onError(error);
        }
      }
    } finally {
      this.#running.delete(key);
      if (this.#running.size === 0) {
        for (const resolve of this.#idle) resolve();
        this.#idle.clear();
      }
    }
  }
}
