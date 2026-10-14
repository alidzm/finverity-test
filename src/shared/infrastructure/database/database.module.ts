import { Global, Module } from '@nestjs/common';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { DatabaseService } from './database.service';
import { DrizzleTransactionManager } from './drizzle-transaction-manager';

@Global()
@Module({
  providers: [
    DatabaseService,
    DrizzleTransactionManager,
    { provide: TransactionManager, useExisting: DrizzleTransactionManager },
  ],
  exports: [DatabaseService, DrizzleTransactionManager, TransactionManager],
})
export class DatabaseModule {}
