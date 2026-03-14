import { eq, sql } from "drizzle-orm";
import type { db } from "../db";
import { profile, walletLedger } from "../db/schema";

export type WalletTotals = {
	balance: number;
	lifetimeCredited: number;
	lifetimeDebited: number;
};

type WalletQueryExecutor = {
	select: typeof db.select;
};

type WalletLockExecutor = {
	execute: typeof db.execute;
};

export const getWalletTotals = async (
	executor: WalletQueryExecutor,
	userId: string,
): Promise<WalletTotals> => {
	const [totals] = await executor
		.select({
			balance: sql<number>`(
				coalesce(sum(case when ${walletLedger.direction} = 'credit' then ${walletLedger.amount} else 0 end), 0) -
				coalesce(sum(case when ${walletLedger.direction} = 'debit' then ${walletLedger.amount} else 0 end), 0)
			)::int`,
			lifetimeCredited: sql<number>`coalesce(sum(case when ${walletLedger.direction} = 'credit' then ${walletLedger.amount} else 0 end), 0)::int`,
			lifetimeDebited: sql<number>`coalesce(sum(case when ${walletLedger.direction} = 'debit' then ${walletLedger.amount} else 0 end), 0)::int`,
		})
		.from(walletLedger)
		.where(eq(walletLedger.userId, userId));

	return (
		totals ?? {
			balance: 0,
			lifetimeCredited: 0,
			lifetimeDebited: 0,
		}
	);
};

export const lockWalletProfile = async (
	executor: WalletLockExecutor,
	userId: string,
) => {
	const result = await executor.execute(sql<{ userId: string }>`
		select ${profile.userId} as "userId"
		from ${profile}
		where ${profile.userId} = ${userId}
		for update
	`);

	return result.rows.length > 0;
};
