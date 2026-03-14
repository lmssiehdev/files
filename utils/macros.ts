import { Elysia } from "elysia";
import { auth } from "../lib/auth";

export const betterAuthMacro = new Elysia({ name: "better-auth" })
	.mount(auth.handler)
	.macro({
		auth: {
			async resolve({ status, request: { headers } }) {
				const session = await auth.api.getSession({ headers });
				if (!session) return status(401);
				return { user: session.user, session: session.session };
			},
		},
		authOptional: {
			async resolve({ request: { headers } }) {
				const session = await auth.api.getSession({ headers });
				return {
					user: session?.user ?? null,
					session: session?.session ?? null,
				};
			},
		},
	});
