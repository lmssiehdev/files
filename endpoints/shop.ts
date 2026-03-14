import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db";
import { bundleItems, inventory, items, walletLedger } from "../db/schema";
import { getWalletTotals, lockWalletProfile } from "../lib/wallet";
import { betterAuthMacro } from "../utils/macros";
import { ItemTypeSchema } from "../utils/validation";

const parseBool = (value?: string) => {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
};

const bundleContentSchema = t.Object({
	itemId: t.String(),
	quantity: t.Number(),
	type: ItemTypeSchema,
	assetKey: t.Nullable(t.String()),
	gameId: t.Nullable(t.String()),
	price: t.Number(),
	isFree: t.Boolean(),
	isLimited: t.Boolean(),
});

const shopItemSchema = t.Object({
	id: t.String(),
	type: ItemTypeSchema,
	assetKey: t.Nullable(t.String()),
	gameId: t.Nullable(t.String()),
	price: t.Number(),
	isFree: t.Boolean(),
	isLimited: t.Boolean(),
	isBundle: t.Boolean(),
	createdAt: t.Date(),
	owned: t.Boolean(),
	bundleContents: t.Array(bundleContentSchema),
});

const purchaseItemSummarySchema = t.Object({
	id: t.String(),
	type: ItemTypeSchema,
	assetKey: t.Nullable(t.String()),
	gameId: t.Nullable(t.String()),
	price: t.Number(),
	isFree: t.Boolean(),
	isLimited: t.Boolean(),
	isBundle: t.Boolean(),
});

const purchaseHistoryEntrySchema = t.Object({
	ledgerId: t.String(),
	purchaseId: t.Nullable(t.String()),
	itemId: t.Nullable(t.String()),
	amount: t.Number(),
	purchasedAt: t.Date(),
	item: t.Nullable(purchaseItemSummarySchema),
});

type BundleContentsByBundleId = Record<
	string,
	Array<{
		itemId: string;
		quantity: number;
		type: "hat" | "back_item" | "skin" | "bundle";
		assetKey: string | null;
		gameId: string | null;
		price: number;
		isFree: boolean;
		isLimited: boolean;
	}>
>;

async function getBundleContents(bundleIds: string[]) {
	if (!bundleIds.length) return {} as BundleContentsByBundleId;

	const rows = await db
		.select({
			bundleId: bundleItems.bundleId,
			itemId: bundleItems.itemId,
			quantity: bundleItems.quantity,
			type: items.type,
			assetKey: items.assetKey,
			gameId: items.gameId,
			price: items.price,
			isFree: items.isFree,
			isLimited: items.isLimited,
		})
		.from(bundleItems)
		.innerJoin(items, eq(items.id, bundleItems.itemId))
		.where(inArray(bundleItems.bundleId, bundleIds));

	return rows.reduce<BundleContentsByBundleId>((acc, row) => {
		if (!acc[row.bundleId]) {
			acc[row.bundleId] = [];
		}

		const bucket = acc[row.bundleId];
		if (!bucket) return acc;

		bucket.push({
			itemId: row.itemId,
			quantity: row.quantity,
			type: row.type,
			assetKey: row.assetKey,
			gameId: row.gameId,
			price: row.price,
			isFree: row.isFree,
			isLimited: row.isLimited,
		});
		return acc;
	}, {});
}

const parsePurchaseMetadata = (value: unknown) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {
			itemId: null,
			purchaseId: null,
		};
	}

	const metadata = value as Record<string, unknown>;

	return {
		itemId: typeof metadata.itemId === "string" ? metadata.itemId : null,
		purchaseId:
			typeof metadata.purchaseId === "string" ? metadata.purchaseId : null,
	};
};

export const ShopRouter = new Elysia({ prefix: "/shop", tags: ["Shop"] })
	.use(betterAuthMacro)
	.get(
		"/",
		async ({ user, query }) => {
			const {
				gameId,
				type,
				isFree,
				isLimited,
				isBundle,
				limit = 20,
				page = 1,
			} = query;

			const filters = [
				type ? eq(items.type, type) : undefined,
				gameId
					? gameId === "global"
						? isNull(items.gameId)
						: eq(items.gameId, gameId)
					: undefined,
				parseBool(isFree) === undefined
					? undefined
					: eq(items.isFree, parseBool(isFree) as boolean),
				parseBool(isLimited) === undefined
					? undefined
					: eq(items.isLimited, parseBool(isLimited) as boolean),
				parseBool(isBundle) === undefined
					? undefined
					: eq(items.isBundle, parseBool(isBundle) as boolean),
			].filter(Boolean);

			const offset = (page - 1) * limit;

			const [rows, totalRows] = await Promise.all([
				db
					.select()
					.from(items)
					.where(filters.length ? and(...filters) : undefined)
					.orderBy(desc(items.createdAt))
					.limit(limit)
					.offset(offset),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(items)
					.where(filters.length ? and(...filters) : undefined),
			]);

			const bundleIds = rows
				.filter((item) => item.isBundle || item.type === "bundle")
				.map((item) => item.id);

			const [bundleContentsByBundleId, ownedRows] = await Promise.all([
				getBundleContents(bundleIds),
				(async () => {
					if (!user || !rows.length) return [] as Array<{ itemId: string }>;
					return db
						.selectDistinct({ itemId: inventory.itemId })
						.from(inventory)
						.where(
							and(
								eq(inventory.userId, user.id),
								inArray(
									inventory.itemId,
									rows.map((row) => row.id),
								),
							),
						);
				})(),
			]);

			const ownedSet = new Set(ownedRows.map((row) => row.itemId));

			return {
				items: rows.map((item) => ({
					...item,
					owned: ownedSet.has(item.id),
					bundleContents: bundleContentsByBundleId[item.id] ?? [],
				})),
				total: totalRows[0]?.count ?? 0,
				page,
				limit,
			};
		},
		{
			authOptional: true,
			query: t.Object({
				type: t.Optional(ItemTypeSchema),
				gameId: t.Optional(t.String()),
				isFree: t.Optional(t.String()),
				isLimited: t.Optional(t.String()),
				isBundle: t.Optional(t.String()),
				page: t.Optional(t.Numeric({ minimum: 1, default: 1 })),
				limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, default: 20 })),
			}),
			response: t.Object({
				items: t.Array(shopItemSchema),
				total: t.Number(),
				page: t.Number(),
				limit: t.Number(),
			}),
			detail: {
				summary: "List shop items",
				description:
					"Returns paginated shop items with filter support. If authenticated, includes owned state and bundle contents.",
			},
		},
	)
	.get(
		"/item",
		async ({ user, query, status }) => {
			const item = await db.query.items.findFirst({
				where: eq(items.id, query.itemId),
			});

			if (!item) return status(404, { message: "Item not found" });

			const [bundleContentsByBundleId, ownedRow] = await Promise.all([
				getBundleContents(
					item.isBundle || item.type === "bundle" ? [item.id] : [],
				),
				(async () => {
					if (!user) return null;
					return db.query.inventory.findFirst({
						where: and(
							eq(inventory.userId, user.id),
							eq(inventory.itemId, item.id),
						),
						columns: {
							itemId: true,
						},
					});
				})(),
			]);

			return {
				...item,
				owned: !!ownedRow,
				bundleContents: bundleContentsByBundleId[item.id] ?? [],
			};
		},
		{
			authOptional: true,
			query: t.Object({
				itemId: t.String(),
			}),
			response: {
				200: shopItemSchema,
				404: t.Object({ message: t.String() }),
			},
			detail: {
				summary: "Get a single shop item",
				description:
					"Returns item details, ownership state, and bundle contents if applicable.",
			},
		},
	)
	.post(
		"/history",
		async ({ user, body }) => {
			const { page = 1, limit = 20 } = body;
			const offset = (page - 1) * limit;

			const purchaseFilter = and(
				eq(walletLedger.userId, user.id),
				eq(walletLedger.reason, "shop_purchase"),
				eq(walletLedger.direction, "debit"),
			);

			const [ledgerRows, totalRows] = await Promise.all([
				db
					.select({
						id: walletLedger.id,
						amount: walletLedger.amount,
						metadata: walletLedger.metadata,
						createdAt: walletLedger.createdAt,
					})
					.from(walletLedger)
					.where(purchaseFilter)
					.orderBy(desc(walletLedger.createdAt))
					.limit(limit)
					.offset(offset),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(walletLedger)
					.where(purchaseFilter),
			]);

			const parsedRows = ledgerRows.map((row) => ({
				...row,
				parsedMetadata: parsePurchaseMetadata(row.metadata),
			}));

			const itemIds = [
				...new Set(
					parsedRows
						.map((row) => row.parsedMetadata.itemId)
						.filter((itemId): itemId is string => !!itemId),
				),
			];

			const itemRows = itemIds.length
				? await db
						.select({
							id: items.id,
							type: items.type,
							assetKey: items.assetKey,
							gameId: items.gameId,
							price: items.price,
							isFree: items.isFree,
							isLimited: items.isLimited,
							isBundle: items.isBundle,
						})
						.from(items)
						.where(inArray(items.id, itemIds))
				: [];

			const itemById = new Map(itemRows.map((row) => [row.id, row]));

			return {
				purchases: parsedRows.map((row) => ({
					ledgerId: row.id,
					purchaseId: row.parsedMetadata.purchaseId,
					itemId: row.parsedMetadata.itemId,
					amount: row.amount,
					purchasedAt: row.createdAt,
					item: row.parsedMetadata.itemId
						? (itemById.get(row.parsedMetadata.itemId) ?? null)
						: null,
				})),
				total: totalRows[0]?.count ?? 0,
				page,
				limit,
			};
		},
		{
			auth: true,
			body: t.Object({
				page: t.Optional(t.Number({ minimum: 1, default: 1 })),
				limit: t.Optional(t.Number({ minimum: 1, maximum: 50, default: 20 })),
			}),
			response: t.Object({
				purchases: t.Array(purchaseHistoryEntrySchema),
				total: t.Number(),
				page: t.Number(),
				limit: t.Number(),
			}),
			detail: {
				summary: "List paid purchase history",
				description:
					"Returns paginated paid shop purchases from wallet ledger entries for the authenticated user.",
			},
		},
	)
	.post(
		"/buy",
		async ({ user, body, status }) => {
			const item = await db.query.items.findFirst({
				where: eq(items.id, body.itemId),
			});

			if (!item) return status(404, { message: "Item not found" });

			const isBundle = item.isBundle || item.type === "bundle";
			const packContents = isBundle
				? await db
						.select({
							itemId: bundleItems.itemId,
							quantity: bundleItems.quantity,
						})
						.from(bundleItems)
						.where(eq(bundleItems.bundleId, item.id))
				: [];

			if (isBundle && !packContents.length) {
				return status(400, { message: "Bundle has no items" });
			}

			const purchaseId = randomUUID();
			const cost = item.isFree ? 0 : item.price;

			const result = await db.transaction(async (tx) => {
				const hasProfile = await lockWalletProfile(tx, user.id);

				if (!hasProfile) {
					return {
						ok: false as const,
						error: "PROFILE_NOT_FOUND" as const,
					};
				}

				let remainingBalance: number | null = null;

				if (cost > 0) {
					const walletTotals = await getWalletTotals(tx, user.id);

					if (walletTotals.balance < cost) {
						return {
							ok: false as const,
							error: "INSUFFICIENT_BALANCE" as const,
							balance: walletTotals.balance,
						};
					}

					remainingBalance = walletTotals.balance - cost;

					await tx.insert(walletLedger).values({
						id: randomUUID(),
						userId: user.id,
						amount: cost,
						direction: "debit",
						reason: "shop_purchase",
						provider: "xsolla",
						idempotencyKey: `shop:purchase:${purchaseId}`,
						metadata: {
							itemId: item.id,
							purchaseId,
							itemType: item.type,
						},
					});
				}

				if (isBundle) {
					await tx
						.insert(inventory)
						.values({
							userId: user.id,
							itemId: item.id,
							quantity: 1,
						})
						.onConflictDoUpdate({
							target: [inventory.userId, inventory.itemId],
							set: {
								quantity: sql`${inventory.quantity} + 1`,
							},
						});

					for (const content of packContents) {
						await tx
							.insert(inventory)
							.values({
								userId: user.id,
								itemId: content.itemId,
								bundleId: item.id,
								quantity: content.quantity,
							})
							.onConflictDoUpdate({
								target: [inventory.userId, inventory.itemId],
								set: {
									quantity: sql`${inventory.quantity} + ${content.quantity}`,
									bundleId: sql`coalesce(${inventory.bundleId}, ${item.id})`,
								},
							});
					}

					return {
						ok: true as const,
						purchasedItemId: item.id,
						grantedCount: packContents.length,
						balance: remainingBalance,
					};
				}

				await tx
					.insert(inventory)
					.values({
						userId: user.id,
						itemId: item.id,
						quantity: 1,
					})
					.onConflictDoUpdate({
						target: [inventory.userId, inventory.itemId],
						set: {
							quantity: sql`${inventory.quantity} + 1`,
						},
					});

				return {
					ok: true as const,
					purchasedItemId: item.id,
					grantedCount: 1,
					balance: remainingBalance,
				};
			});

			if (!result.ok) {
				if (result.error === "PROFILE_NOT_FOUND") {
					return status(404, { message: "Profile not found" });
				}

				return status(402, {
					message: "Insufficient balance",
					balance: result.balance ?? 0,
					required: cost,
				});
			}

			const responseBalance =
				result.balance ?? (await getWalletTotals(db, user.id)).balance;

			return {
				success: true,
				purchasedItemId: result.purchasedItemId,
				grantedCount: result.grantedCount,
				balance: responseBalance,
			};
		},
		{
			auth: true,
			body: t.Object({
				itemId: t.String(),
			}),
			response: {
				200: t.Object({
					success: t.Boolean(),
					purchasedItemId: t.String(),
					grantedCount: t.Number(),
					balance: t.Number(),
				}),
				400: t.Object({ message: t.String() }),
				402: t.Object({
					message: t.String(),
					balance: t.Number(),
					required: t.Number(),
				}),
				404: t.Object({ message: t.String() }),
			},
			detail: {
				summary: "Buy a shop item",
				description:
					"Purchases a regular item or bundle for the authenticated user and writes inventory records.",
			},
		},
	);
