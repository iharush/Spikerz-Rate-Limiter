import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  commandReceiptSchema,
  type AdminAction,
  type CommandReceipt,
} from '../../../packages/contracts/src/index.js';
import { ControlRepository } from './repository.js';

@Injectable()
export class ControlService {
  constructor(private readonly repository: ControlRepository) {}

  async execute(
    userId: string,
    actor: string,
    key: string,
    action: AdminAction,
  ): Promise<CommandReceipt> {
    const record = await this.repository.reserve(userId, actor, key, action);
    if (record.status === 'applied' && record.result) return record.result;
    try {
      // One direct call per HTTP attempt. There is no worker or automatic retry.
      const response = await fetch(`${process.env.DATA_INTERNAL_URL}/internal/commands`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          'content-type': 'application/json',
          'x-service-key': process.env.INTERNAL_SERVICE_KEY!,
        },
        body: JSON.stringify({ commandId: record.command_id, userId, action }),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const message = `Data plane rejected command (${response.status})`;
          await this.repository.unsuccessful(record.command_id, 'failed', message);
          throw new HttpException(message, response.status);
        }
        throw new Error(`Data plane returned ${response.status}`);
      }
      const receipt = commandReceiptSchema.parse(await response.json());
      if (receipt.commandId !== record.command_id || receipt.state.userId !== userId)
        throw new Error('Invalid data-plane receipt');
      await this.repository.applied(record.command_id, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const message =
        'Could not confirm the change. Retry the same request with the same Idempotency-Key; it will not be applied twice.';
      // A lost response may follow a committed data transaction. Preserve the
      // command ID for an explicit retry instead of claiming the change failed.
      await this.repository.unsuccessful(record.command_id, 'unconfirmed', message).catch(() => {});
      throw new ServiceUnavailableException({
        statusCode: 503,
        message,
        commandId: record.command_id,
      });
    }
  }
}
