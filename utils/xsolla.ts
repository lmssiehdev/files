import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../env";

const SHA1_HEX_PATTERN = /^[0-9a-f]{40}$/;

const secureCompareHexSha1 = (a: string, b: string) => {
	if (!SHA1_HEX_PATTERN.test(a) || !SHA1_HEX_PATTERN.test(b)) return false;
	return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};

const readSignatureHeader = (value: string) => {
	const match = value.trim().match(/^Signature ([0-9a-fA-F]{40})$/);
	return match?.[1]?.toLowerCase();
};

export const isValidXsollaWebhookSignature = (
	rawBody: string,
	headers: Headers,
): boolean => {
	const secret = env.XSOLLA_WEBHOOK_SECRET;
	if (!secret) {
		console.error(
			"[xsolla-signature] Missing XSOLLA_WEBHOOK_SECRET; rejecting webhook",
		);
		return false;
	}

	const signatureHeader = headers.get("authorization");

	if (!signatureHeader) {
		console.warn(
			"[xsolla-signature] Missing authorization header; rejecting webhook",
		);
		return false;
	}

	const givenSignature = readSignatureHeader(signatureHeader);
	if (!givenSignature) {
		console.warn("[xsolla-signature] Invalid authorization header format", {
			authorizationHeaderPrefix: signatureHeader.slice(0, 32),
		});
		return false;
	}

	const expectedSha1 = createHash("sha1")
		.update(`${rawBody}${secret}`, "utf8")
		.digest("hex");

	const isValid = secureCompareHexSha1(givenSignature, expectedSha1);

	if (!isValid) {
		console.warn("[xsolla-signature] Signature mismatch", {
			signaturePrefix: givenSignature.slice(0, 8),
			bodyLength: rawBody.length,
		});
	}

	return isValid;
};

export type ParsedXsollaWebhook = {
	notificationType: string;
	providerOrderId?: string;
	providerPaymentId?: string;
	externalInvoiceId?: string;
	providerEventId?: string;
	userExternalId?: string;
	isPaidEvent: boolean;
	isRefundEvent: boolean;
	isUserValidationEvent: boolean;
	isIgnoredEvent: boolean;
};

export function parseXsollaWebhook(
	body: Record<string, any>,
): ParsedXsollaWebhook {
	const notificationType: string = body.notification_type;

	const isPaidEvent = notificationType === "payment";
	const isRefundEvent = notificationType === "refund";
	const isUserValidationEvent = notificationType === "user_validation";
	const isIgnoredEvent =
		!isPaidEvent && !isRefundEvent && !isUserValidationEvent;

	return {
		notificationType,
		providerOrderId: body.transaction?.payment_method_order_id ?? undefined,
		providerPaymentId: body.transaction?.id?.toString() ?? undefined,
		externalInvoiceId: body.custom_parameters?.external_invoice_id ?? undefined,
		providerEventId: body.transaction?.external_id ?? undefined,
		userExternalId: body.user?.id ?? undefined,
		isPaidEvent,
		isRefundEvent,
		isUserValidationEvent,
		isIgnoredEvent,
	};
}
