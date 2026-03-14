import { and, eq, ne } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db";
import { user as authUser } from "../db/schema/auth";
import { profile } from "../db/schema/main";
import { getWalletTotals } from "../lib/wallet";
import { betterAuthMacro } from "../utils/macros";

const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;

export const UserRouter = new Elysia({ prefix: "/user", tags: ["User"] })
	.use(betterAuthMacro)
	.get(
		"/profile",
		async ({ user, status }) => {
			const [userProfile] = await db
				.select({
					userId: profile.userId,
					username: authUser.username,
				})
				.from(profile)
				.innerJoin(authUser, eq(authUser.id, profile.userId))
				.where(eq(profile.userId, user.id))
				.limit(1);

			if (!userProfile) {
				return status(404, { message: "Profile not found" });
			}

			const walletTotals = await getWalletTotals(db, user.id);

			return {
				...userProfile,
				...walletTotals,
			};
		},
		{
			auth: true,
			response: {
				200: t.Object({
					userId: t.String(),
					username: t.Nullable(t.String()),
					balance: t.Number(),
					lifetimeCredited: t.Number(),
					lifetimeDebited: t.Number(),
				}),
				404: t.Object({ message: t.String() }),
			},
			detail: {
				summary: "Get authenticated profile",
				description:
					"Returns profile details including current wallet balance for the authenticated user.",
			},
		},
	)
	.post(
		"/username",
		async ({ user, body, status }) => {
			const nextUsername = body.username.trim();

			if (!USERNAME_REGEX.test(nextUsername)) {
				return status(400, {
					message:
						"Username must be 3-20 characters and only contain letters, numbers, or underscores.",
				});
			}

			const existing = await db.query.user.findFirst({
				where: and(
					eq(authUser.username, nextUsername),
					ne(authUser.id, user.id),
				),
				columns: {
					id: true,
				},
			});

			if (existing) {
				return status(409, { message: "Username is already taken" });
			}

			const [updated] = await db
				.update(authUser)
				.set({ username: nextUsername, updatedAt: new Date() })
				.where(eq(authUser.id, user.id))
				.returning({ username: authUser.username });

			if (!updated) {
				return status(404, { message: "User not found" });
			}

			return { username: updated.username };
		},
		{
			auth: true,
			body: t.Object({
				username: t.String({ minLength: 3, maxLength: 20 }),
			}),
			response: {
				200: t.Object({ username: t.Nullable(t.String()) }),
				400: t.Object({ message: t.String() }),
				404: t.Object({ message: t.String() }),
				409: t.Object({ message: t.String() }),
			},
			detail: {
				summary: "Update current username",
				description:
					"Updates the authenticated user's username. Requires Bearer token authentication.",
			},
		},
	)
	.post(
		"/delete",
		async ({ user, status }) => {
			const deleted = await db
				.delete(authUser)
				.where(eq(authUser.id, user.id))
				.returning({ id: authUser.id });

			if (!deleted.length) {
				return status(404, { message: "User not found" });
			}

			return { success: true };
		},
		{
			auth: true,
			response: {
				200: t.Object({ success: t.Boolean() }),
				400: t.Object({ message: t.String() }),
				404: t.Object({ message: t.String() }),
			},
			detail: {
				summary: "Delete current account",
				description:
					"Permanently deletes the authenticated user's account and all related records.",
			},
		},
	);
