import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import {
	paymentOrder,
	profile,
	user,
	walletLedger,
	webhookEvent,
} from "../db/schema";
import { lockWalletProfile } from "../lib/wallet";
import {
	isValidXsollaWebhookSignature,
	parseXsollaWebhook,
} from "../utils/xsolla";

type WebhookOutcome = {
	responseCode: number;
	responseBody: Record<string, unknown> | null;
	processingStatus: "processed" | "ignored" | "failed";
	processingError: string | null;
};

class RetryableWebhookError extends Error {}

const payloadHash = (rawBody: string) =>
	createHash("sha256").update(rawBody, "utf8").digest("hex");

const toResponse = (
	outcome: Pick<WebhookOutcome, "responseCode" | "responseBody">,
) => {
	if (!outcome.responseBody || outcome.responseCode === 204) {
		return new Response(null, { status: outcome.responseCode });
	}

	return Response.json(outcome.responseBody, { status: outcome.responseCode });
};

const persistOutcome = async (eventId: string, outcome: WebhookOutcome) => {
	await db
		.update(webhookEvent)
		.set({
			processingStatus: outcome.processingStatus,
			processingError: outcome.processingError,
			responseCode: outcome.responseCode,
			responseBody: outcome.responseBody,
			processedAt: new Date(),
		})
		.where(eq(webhookEvent.id, eventId));
};

const processUserValidation = async (
	userExternalId?: string,
): Promise<WebhookOutcome> => {
	if (!userExternalId) {
		// log user_validation is missing userExternalId
		return {
			responseCode: 400,
			responseBody: {
				error: {
					code: "INVALID_USER",
					message: "Invalid user",
				},
			},
			processingStatus: "failed",
			processingError: "Missing user id",
		};
	}

	const existingUser = await db.query.user.findFirst({
		where: eq(user.id, userExternalId),
		columns: {
			id: true,
		},
	});

	if (!existingUser) {
		// log user_validation user not found
		return {
			responseCode: 400,
			responseBody: {
				error: {
					code: "INVALID_USER",
					message: "Invalid user",
				},
			},
			processingStatus: "failed",
			processingError: "User not found",
		};
	}

	return {
		responseCode: 204,
		responseBody: null,
		processingStatus: "processed",
		processingError: null,
	};
};

const processOrderPaid = async (
	providerOrderId: string | undefined,
	externalInvoiceId: string | undefined,
	providerPaymentId: string | undefined,
	notificationType: string,
	providerEventId: string,
	providerPayload: Record<string, unknown>,
): Promise<WebhookOutcome> => {
	if (!providerOrderId && !externalInvoiceId) {
		// log order_paid missing order references
		return {
			responseCode: 400,
			responseBody: {
				error: {
					code: "INCORRECT_INVOICE",
					message: "Incorrect invoice",
				},
			},
			processingStatus: "failed",
			processingError: "Missing provider order id and external invoice id",
		};
	}

	await db.transaction(async (tx) => {
		let order = providerOrderId
			? await tx.query.paymentOrder.findFirst({
					where: and(
						eq(paymentOrder.providerOrderId, providerOrderId),
						eq(paymentOrder.provider, "xsolla"),
					),
				})
			: undefined;

		if (!order && externalInvoiceId) {
			order = await tx.query.paymentOrder.findFirst({
				where: and(
					eq(paymentOrder.externalInvoiceId, externalInvoiceId),
					eq(paymentOrder.provider, "xsolla"),
				),
			});
		}

		if (!order) {
			// log order_paid could not find payment order
			throw new RetryableWebhookError("Order not found");
		}

		if (providerOrderId && order.providerOrderId !== providerOrderId) {
			await tx
				.update(paymentOrder)
				.set({
					providerOrderId,
					updatedAt: new Date(),
				})
				.where(eq(paymentOrder.id, order.id));

			order = {
				...order,
				providerOrderId,
			};
		}

		if (
			order.status === "cancelled" ||
			order.status === "refunded" ||
			order.status === "chargeback"
		) {
			// log order_paid ignored due to terminal status
			return;
		}

		if (order.status !== "paid") {
			const idempotencyKey = `xsolla:order:${order.id}:paid`;

			const [ledgerRow] = await tx
				.insert(walletLedger)
				.values({
					id: randomUUID(),
					userId: order.userId,
					paymentOrderId: order.id,
					amount: order.requestedAmount,
					direction: "credit",
					reason: "topup",
					provider: "xsolla",
					providerPaymentId,
					idempotencyKey,
					metadata: {
						notificationType,
						providerOrderId,
						providerEventId,
					},
				})
				.onConflictDoNothing()
				.returning({ id: walletLedger.id });

			if (ledgerRow) {
				const profileRow = await tx.query.profile.findFirst({
					where: eq(profile.userId, order.userId),
					columns: {
						userId: true,
					},
				});

				if (!profileRow) {
					// log order_paid profile missing for payment order
					throw new RetryableWebhookError(
						"Profile not found for payment order",
					);
				}
			}

			if (!ledgerRow) {
				console.info(
					"[xsolla-webhook] order_paid ledger insert skipped due to idempotency",
					{
						providerEventId,
						orderId: order.id,
					},
				);
			}
		}

		await tx
			.update(paymentOrder)
			.set({
				status: "paid",
				providerPaymentId: providerPaymentId ?? order.providerPaymentId,
				xsollaNotificationType: notificationType,
				metadata: providerPayload,
				paidAt: order.paidAt ?? new Date(),
				updatedAt: new Date(),
			})
			.where(eq(paymentOrder.id, order.id));
	});

	// log order_paid

	return {
		responseCode: 204,
		responseBody: null,
		processingStatus: "processed",
		processingError: null,
	};
};

const processRefund = async (
	providerOrderId: string | undefined,
	externalInvoiceId: string | undefined,
	providerPaymentId: string | undefined,
	notificationType: string,
	providerEventId: string,
	providerPayload: Record<string, unknown>,
): Promise<WebhookOutcome> => {
	if (!providerOrderId && !externalInvoiceId) {
		// log refund missing order references
		return {
			responseCode: 400,
			responseBody: {
				error: {
					code: "INCORRECT_INVOICE",
					message: "Incorrect invoice",
				},
			},
			processingStatus: "failed",
			processingError: "Missing provider order id and external invoice id",
		};
	}

	await db.transaction(async (tx) => {
		let order = providerOrderId
			? await tx.query.paymentOrder.findFirst({
					where: and(
						eq(paymentOrder.providerOrderId, providerOrderId),
						eq(paymentOrder.provider, "xsolla"),
					),
				})
			: undefined;

		if (!order && externalInvoiceId) {
			order = await tx.query.paymentOrder.findFirst({
				where: and(
					eq(paymentOrder.externalInvoiceId, externalInvoiceId),
					eq(paymentOrder.provider, "xsolla"),
				),
			});
		}

		if (!order) {
			// log refund could not find payment order
			throw new RetryableWebhookError("Order not found");
		}

		if (providerOrderId && order.providerOrderId !== providerOrderId) {
			await tx
				.update(paymentOrder)
				.set({
					providerOrderId,
					updatedAt: new Date(),
				})
				.where(eq(paymentOrder.id, order.id));

			order = {
				...order,
				providerOrderId,
			};
		}

		if (
			order.status === "cancelled" ||
			order.status === "refunded" ||
			order.status === "chargeback"
		) {
			// log refund ignored due to terminal status
			return;
		}

		if (order.status === "paid") {
			const hasProfile = await lockWalletProfile(tx, order.userId);

			if (!hasProfile) {
				// log refund profile missing for payment order
				throw new RetryableWebhookError("Profile not found for payment order");
			}

			const idempotencyKey = `xsolla:order:${order.id}:refund`;

			const [ledgerRow] = await tx
				.insert(walletLedger)
				.values({
					id: randomUUID(),
					userId: order.userId,
					paymentOrderId: order.id,
					amount: order.requestedAmount,
					direction: "debit",
					reason: "refund",
					provider: "xsolla",
					providerPaymentId,
					idempotencyKey,
					metadata: {
						notificationType,
						providerOrderId,
						providerEventId,
					},
				})
				.onConflictDoNothing()
				.returning({ id: walletLedger.id });

			if (!ledgerRow) {
				// log refund ledger insert skipped due to idempotency
			}
		}

		await tx
			.update(paymentOrder)
			.set({
				status: "refunded",
				xsollaNotificationType: notificationType,
				providerPaymentId: providerPaymentId ?? order.providerPaymentId,
				metadata: providerPayload,
				refundedAt: order.refundedAt ?? new Date(),
				updatedAt: new Date(),
			})
			.where(eq(paymentOrder.id, order.id));
	});

	// log refund processed

	return {
		responseCode: 204,
		responseBody: null,
		processingStatus: "processed",
		processingError: null,
	};
};

export const WebhookRouter = new Elysia({
	prefix: "/webhooks",
	tags: ["Payments"],
}).post("/xsolla", async ({ request }) => {
	const rawBody = await request.text();
	const bodyHash = payloadHash(rawBody);

	// log webhook received

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(rawBody) as Record<string, unknown>;
	} catch (error) {
		// log failed to parse webhook payload
		return Response.json(
			{
				error: {
					code: "INVALID_PARAMETER",
					message: "Invalid parameter",
				},
			},
			{ status: 400 },
		);
	}

	const parsed = parseXsollaWebhook(payload);
	const dedupeSource = parsed.providerEventId ?? bodyHash;
	const dedupeKey = `xsolla:${parsed.notificationType}:${dedupeSource}`;
	const signatureValid = isValidXsollaWebhookSignature(
		rawBody,
		request.headers,
	);

	// log parsed and validated payload

	const [createdEvent] = await db
		.insert(webhookEvent)
		.values({
			id: randomUUID(),
			provider: "xsolla",
			providerEventId: parsed.providerEventId,
			dedupeKey,
			notificationType: parsed.notificationType,
			signatureValid,
			payloadHash: bodyHash,
			payload,
			processingStatus: "pending",
		})
		.onConflictDoNothing()
		.returning({ id: webhookEvent.id });

	if (!createdEvent) {
		// log duplicate webhook detected
		const existingEvent = await db.query.webhookEvent.findFirst({
			where: and(
				eq(webhookEvent.provider, "xsolla"),
				eq(webhookEvent.dedupeKey, dedupeKey),
			),
		});

		if (!existingEvent) {
			// duplicate dedupe hit without event row
			return new Response(null, { status: 204 });
		}

		if (!existingEvent.responseCode) {
			const fallbackCode =
				existingEvent.processingStatus === "processed" ||
				existingEvent.processingStatus === "ignored"
					? 204
					: 500;

			// duplicate webhook missing stored response code
			return new Response(null, { status: fallbackCode });
		}

		// replying stored webhook response
		return toResponse({
			responseCode: existingEvent.responseCode,
			responseBody:
				(existingEvent.responseBody as Record<string, string>) ?? null,
		});
	}

	// log persisted new webhook event

	let outcome: WebhookOutcome;

	if (!signatureValid) {
		// rejecting webhook due to invalid signature
		outcome = {
			responseCode: 400,
			responseBody: {
				error: {
					code: "INVALID_SIGNATURE",
					message: "Invalid signature",
				},
			},
			processingStatus: "failed",
			processingError: "Invalid signature",
		};
		await persistOutcome(createdEvent.id, outcome);
		return toResponse(outcome);
	}

	try {
		if (parsed.isUserValidationEvent) {
			outcome = await processUserValidation(parsed.userExternalId);
		} else if (parsed.isPaidEvent) {
			outcome = await processOrderPaid(
				parsed.providerOrderId,
				parsed.externalInvoiceId,
				parsed.providerPaymentId,
				parsed.notificationType,
				dedupeSource,
				payload,
			);
		} else if (parsed.isRefundEvent) {
			outcome = await processRefund(
				parsed.providerOrderId,
				parsed.externalInvoiceId,
				parsed.providerPaymentId,
				parsed.notificationType,
				dedupeSource,
				payload,
			);
		} else if (parsed.isIgnoredEvent) {
			outcome = {
				responseCode: 204,
				responseBody: null,
				processingStatus: "ignored",
				processingError: `Ignored event: ${parsed.notificationType}`,
			};
		} else {
			outcome = {
				responseCode: 204,
				responseBody: null,
				processingStatus: "ignored",
				processingError: `Unhandled event: ${parsed.notificationType}`,
			};
		}
	} catch (error) {
		if (error instanceof RetryableWebhookError) {
			// log retryable webhook processing failure
			outcome = {
				responseCode: 500,
				responseBody: null,
				processingStatus: "failed",
				processingError: error.message,
			};
		} else {
			// log unexpected webhook processing failure
			outcome = {
				responseCode: 500,
				responseBody: null,
				processingStatus: "failed",
				processingError:
					error instanceof Error ? error.message : "Unknown processing error",
			};
		}
	}

	await persistOutcome(createdEvent.id, outcome);
	// log persisted webhook outcome
	return toResponse(outcome);
});
