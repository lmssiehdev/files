a few select files from a project i'm working on, built with bun/elysia, drizzle and better auth.

few things to note:

the wallet is an append only ledger, balance is always calculated from the credit/debit entries directly. we do this on all routes for now, but we might want to introduce a cached value for read only routes like /user/profile and keep the live calculation only where it matters like /buy

we use postgres FOR UPDATE to lock the profile row, so if two purchases fire at the same time for the same user, only one transaction goes through at once and the other has to wait for the first to finish before it can proceed. this means two simultaneous purchases can never both spend the same funds

duplicate webhook deliveries are prevent by using a dedupe key, we store each webhook and if it's already processed we return the saved result

and giving inventory items are wrapped in the same db transaction as the ledger debit, so either the charge and the giving both succeed, or they both roll back. a user can't be charged without receiving their item
