import type { PrismaClient } from "./generated/prisma/client.js";
import type {
  AdminBotUnitOfWork,
  TransactionBoundary,
} from "@adminbot/ports";
import { createPrismaClient, type PersistenceOptions } from "./prisma-client.js";
import { createUnitOfWork } from "./prisma-repositories.js";

export interface Persistence {
  readonly transactions: TransactionBoundary;
  close(): Promise<void>;
}

class PrismaTransactionBoundary implements TransactionBoundary {
  constructor(private readonly database: PrismaClient) {}

  read<Result>(
    work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>,
  ): Promise<Result> {
    return this.run(work);
  }

  write<Result>(
    work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>,
  ): Promise<Result> {
    return this.run(work);
  }

  private run<Result>(
    work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>,
  ): Promise<Result> {
    return this.database.$transaction(async (transaction) => work(createUnitOfWork(transaction)));
  }
}

export function openPersistence(options: PersistenceOptions): Persistence {
  const database = createPrismaClient(options);
  return {
    transactions: new PrismaTransactionBoundary(database),
    close: async () => database.$disconnect(),
  };
}
