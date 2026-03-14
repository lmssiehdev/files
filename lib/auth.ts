import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, createAuthMiddleware } from "better-auth/plugins";
import { env, trustedClientOrigins } from "../../env";
import { db } from "../db";
import { profile } from "../db/schema";

const createRandomUsername = () =>
	`user_${Math.random().toString(36).slice(2, 10)}`;

const authBaseURL = new URL(env.API_SERVER_URL).origin;

const socialProviders = {
	...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
		? {
				google: {
					clientId: env.GOOGLE_CLIENT_ID,
					clientSecret: env.GOOGLE_CLIENT_SECRET,
					redirectURI: `${authBaseURL}/api/auth/callback/google`,
				},
			}
		: {}),
	...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
		? {
				discord: {
					clientId: env.DISCORD_CLIENT_ID,
					clientSecret: env.DISCORD_CLIENT_SECRET,
					redirectURI: `${authBaseURL}/api/auth/callback/discord`,
				},
			}
		: {}),
};

export const auth = betterAuth({
	baseURL: authBaseURL,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, {
		provider: "pg",
	}),
	emailAndPassword: {
		enabled: true,
	},
	account: {
		skipStateCookieCheck: true,
		accountLinking: {
			enabled: true,
			trustedProviders: ["google", "discord"],
			allowDifferentEmails: true,
		},
	},
	user: {
		additionalFields: {
			crazygamesUserId: {
				type: "string",
				required: false,
				unique: true,
				input: false,
			},
			username: {
				type: "string",
				required: false,
				unique: true,
			},
		},
	},
	databaseHooks: {
		user: {
			create: {
				before: async (user) => {
					if (!user.username) {
						return {
							data: {
								...user,
								username: createRandomUsername(),
							},
						};
					}
				},
				after: async (user) => {
					await db
						.insert(profile)
						.values({
							id: crypto.randomUUID(),
							userId: user.id,
						})
						.onConflictDoNothing();
				},
			},
		},
	},
	plugins: [bearer()],
	session: {
		cookieCache: {
			enabled: true,
		},
	},
	trustedOrigins: trustedClientOrigins,
	socialProviders,
	hooks: {
		after: createAuthMiddleware(async (ctx) => {
			if (ctx.path.startsWith("/callback/")) {
				const newSession = ctx.context.newSession;
				const responseHeaders = ctx.context.responseHeaders;
				if (!responseHeaders) return;

				const location = responseHeaders.get("location");

				if (newSession && location) {
					const redirectUrl = new URL(location);
					redirectUrl.searchParams.set("token", newSession.session.token);
					responseHeaders.set("location", redirectUrl.toString());
				}
			}
		}),
	},
});
