import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { env } from "../../env";
import { db } from "../db";
import { paymentOrder, profile } from "../db/schema";
import { betterAuthMacro } from "../utils/macros";

const walletPacks = {
	starter_500: {
		coins: 500,
		checkoutAmount: 4.99,
		currency: "USD",
	},
	core_1200: {
		coins: 1200,
		checkoutAmount: 9.99,
		currency: "USD",
	},
	mega_3000: {
		coins: 3000,
		checkoutAmount: 19.99,
		currency: "USD",
	},
} as const;

type WalletPackId = keyof typeof walletPacks;

const getXsollaConfig = () => {
	const merchantId = env.XSOLLA_MERCHANT_ID;
	const projectId = env.XSOLLA_PROJECT_ID;
	const apiKey = env.XSOLLA_API_KEY;

	if (!merchantId || !projectId || !apiKey) {
		return null;
	}

	return {
		merchantId,
		projectId,
		apiKey,
		paystationUrl: env.XSOLLA_PAYSTATION_URL,
	};
};

const buildCheckoutUrl = (baseUrl: string, token: string) => {
	const separator = baseUrl.includes("?") ? "&" : "?";
	return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
};

const createXsollaToken = async (params: {
	merchantId: string;
	projectId: number;
	apiKey: string;
	userId: string;
	externalInvoiceId: string;
	packId: string;
	coins: number;
	checkoutAmount: number;
	currency: string;
}) => {
	const authHeader = Buffer.from(
		`${params.merchantId}:${params.apiKey}`,
	).toString("base64");

	const response = await fetch(
		`https://api.xsolla.com/merchant/v2/merchants/${params.merchantId}/token`,
		{
			method: "POST",
			headers: {
				Authorization: `Basic ${authHeader}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				user: {
					id: {
						value: params.userId,
					},
				},
				settings: {
					project_id: params.projectId,
					external_id: params.externalInvoiceId,
					...(env.XSOLLA_SANDBOX ? { mode: "sandbox" } : {}),
				},
				purchase: {
					checkout: {
						currency: params.currency,
						amount: params.checkoutAmount,
					},
					description: {
						value: `${params.coins.toLocaleString()} coins`,
					},
				},
				custom_parameters: {
					pack_id: params.packId,
					coins: params.coins,
					external_invoice_id: params.externalInvoiceId,
				},
			}),
		},
	);

	if (!response.ok) {
		const reason = await response.text().catch(() => "");
		throw new Error(
			`Xsolla token request failed (${response.status})${reason ? `: ${reason}` : ""}`,
		);
	}

	const payload = (await response.json()) as { token?: string };
	if (!payload.token) {
		throw new Error("Xsolla token response did not include token");
	}

	return payload.token;
};

export const WalletRouter = new Elysia({
	prefix: "/wallet",
	tags: ["Wallet"],
})
	.use(betterAuthMacro)
	.get(
		"/packs",
		() => ({
			packs: Object.fromEntries(
				Object.entries(walletPacks).map(([id, config]) => [id, config.coins]),
			),
		}),
		{
			response: t.Object({
				packs: t.Record(t.String(), t.Number()),
			}),
			detail: {
				summary: "List wallet top-up packs",
				description: "Returns top-up pack IDs and their coin values.",
			},
		},
	)
	.post(
		"/topups/checkout",
		async ({ user, body, status }) => {
			const pack = walletPacks[body.packId as WalletPackId];

			if (!pack) {
				return status(400, { message: "Invalid pack id" });
			}

			const existingProfile = await db.query.profile.findFirst({
				where: eq(profile.userId, user.id),
				columns: {
					userId: true,
				},
			});

			if (!existingProfile) {
				return status(404, { message: "Profile not found" });
			}

			const config = getXsollaConfig();
			if (!config) {
				return status(503, {
					message: "Xsolla checkout is not configured",
				});
			}

			const operationId = randomUUID();
			const now = new Date();
			const pendingProviderOrderId = `pending:${operationId}`;

			await db.insert(paymentOrder).values({
				id: operationId,
				userId: user.id,
				provider: "xsolla",
				providerOrderId: pendingProviderOrderId,
				externalInvoiceId: operationId,
				xsollaNotificationType: "checkout_initialized",
				requestedAmount: pack.coins,
				requestedCurrency: "coins",
				status: "pending",
				metadata: {
					packId: body.packId,
					coins: pack.coins,
					checkoutAmount: pack.checkoutAmount,
					checkoutCurrency: pack.currency,
				},
				createdAt: now,
				updatedAt: now,
			});

			try {
				const token = await createXsollaToken({
					merchantId: config.merchantId,
					projectId: config.projectId,
					apiKey: config.apiKey,
					userId: user.id,
					externalInvoiceId: operationId,
					packId: body.packId,
					coins: pack.coins,
					checkoutAmount: pack.checkoutAmount,
					currency: pack.currency,
				});

				return {
					success: true,
					paymentOrderId: operationId,
					checkoutUrl: buildCheckoutUrl(config.paystationUrl, token),
				};
			} catch (error) {
				await db
					.update(paymentOrder)
					.set({
						status: "failed",
						xsollaNotificationType: "checkout_failed",
						updatedAt: new Date(),
					})
					.where(eq(paymentOrder.id, operationId));

				return status(502, {
					message:
						error instanceof Error
							? error.message
							: "Failed to initialize Xsolla checkout",
				});
			}
		},
		{
			auth: true,
			body: t.Object({
				packId: t.String(),
			}),
			response: {
				200: t.Object({
					success: t.Boolean(),
					paymentOrderId: t.String(),
					checkoutUrl: t.String(),
				}),
				400: t.Object({ message: t.String() }),
				404: t.Object({ message: t.String() }),
				502: t.Object({ message: t.String() }),
				503: t.Object({ message: t.String() }),
			},
			detail: {
				summary: "Create Xsolla checkout for top-up",
				description:
					"Creates a pending payment order and returns a Xsolla checkout URL for the selected pack.",
			},
		},
	);
