import { InMemoryTaskStore, type Task } from '@modelcontextprotocol/server';

import { EventEmitter } from 'node:events';

export class EventedTaskStore extends InMemoryTaskStore {
  public readonly events = new EventEmitter();

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === 'cancelled') {
      this.events.emit('cancelled', taskId);
    }
  }
}

export function createTaskStore(): EventedTaskStore {
  return new EventedTaskStore();
}
