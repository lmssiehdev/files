import { type Static, t } from "elysia";

export const ItemTypeSchema = t.Union([
	t.Literal("hat"),
	t.Literal("back_item"),
	t.Literal("skin"),
	t.Literal("bundle"),
]);

export type ItemType = Static<typeof ItemTypeSchema>;
