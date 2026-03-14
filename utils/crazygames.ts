import { createPublicKey } from "node:crypto";
import { errors, importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import { allowedCrazyGamesGameIds } from "../../env";

const CRAZYGAMES_PUBLIC_KEY_URL = "https://sdk.crazygames.com/publicKey.json";
const CRAZYGAMES_SIGNING_ALGORITHM = "RS256";
const PUBLIC_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

const CrazyGamesPublicKeySchema = z.object({
	publicKey: z.string().min(1),
});

const CrazyGamesTokenPayloadSchema = z.looseObject({
	gameId: z.string().min(1),
	userId: z.string().min(1),
	username: z.string().trim().min(1).optional(),
	profilePictureUrl: z.string().min(1).optional(),
});

type CachedKey = {
	key: CryptoKey;
	expiresAt: number;
};

let cachedKey: CachedKey | null = null;

const importPublicKey = async (publicKeyPem: string) => {
	const normalizedPublicKeyPem = createPublicKey(publicKeyPem)
		.export({ type: "spki", format: "pem" })
		.toString();

	return importSPKI(normalizedPublicKeyPem, CRAZYGAMES_SIGNING_ALGORITHM);
};

const fetchVerificationKey = async () => {
	const response = await fetch(CRAZYGAMES_PUBLIC_KEY_URL);
	if (!response.ok) {
		throw new Error("Failed to fetch CrazyGames public key");
	}

	const payload = CrazyGamesPublicKeySchema.parse(await response.json());
	const key = await importPublicKey(payload.publicKey);

	cachedKey = {
		key,
		expiresAt: Date.now() + PUBLIC_KEY_CACHE_TTL_MS,
	};

	return key;
};

const getVerificationKey = async (forceRefresh: boolean) => {
	if (!forceRefresh && cachedKey && cachedKey.expiresAt > Date.now()) {
		return cachedKey.key;
	}

	return fetchVerificationKey();
};

const isSignatureVerificationError = (error: unknown) =>
	error instanceof errors.JWSSignatureVerificationFailed;

export type CrazyGamesTokenClaims = {
	gameId: string;
	userId: string;
	username: string | null;
	profilePictureUrl: string | null;
};

const parseClaims = (payload: unknown): CrazyGamesTokenClaims => {
	const parsedPayload = CrazyGamesTokenPayloadSchema.parse(payload);

	if (!allowedCrazyGamesGameIds.includes(parsedPayload.gameId)) {
		throw new Error("Invalid CrazyGames game id");
	}

	return {
		gameId: parsedPayload.gameId,
		userId: parsedPayload.userId,
		username: parsedPayload.username ?? null,
		profilePictureUrl: parsedPayload.profilePictureUrl ?? null,
	};
};

export const verifyCrazyGamesToken = async (
	token: string,
): Promise<CrazyGamesTokenClaims> => {
	const verifyWithKey = async (forceRefresh: boolean) => {
		const verificationKey = await getVerificationKey(forceRefresh);

		return jwtVerify(token, verificationKey, {
			algorithms: [CRAZYGAMES_SIGNING_ALGORITHM],
		});
	};

	try {
		const { payload } = await verifyWithKey(false);

		return parseClaims(payload);
	} catch (error) {
		if (!isSignatureVerificationError(error)) {
			throw error;
		}

		const { payload } = await verifyWithKey(true);

		return parseClaims(payload);
	}
};
