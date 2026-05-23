import { queue } from '../mqtt/queue.ts';

class QueueStore {
  pendingCount = $state(0);

  constructor() {
    this.pendingCount = queue.pendingCount;
    queue.onChange(() => {
      this.pendingCount = queue.pendingCount;
    });
  }
}

export const queueStore = new QueueStore();
