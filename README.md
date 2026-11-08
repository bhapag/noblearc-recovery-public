# NobleArc: Restaurant Aggregator Payout Recovery

Software for reconciling restaurant payouts from food-delivery aggregators
(for example Swiggy and Zomato) against POS records and bank settlements, and
surfacing discrepancies for human review: imports, deterministic matching,
classification, recovery cases with evidence, dispute tracking and recovery
verification.

Published as open source under the MIT licence so others can read, learn from
and reuse it. It is an early-stage build, not a hosted service.

## Stack

Next.js (App Router) · React · TypeScript · Prisma 7 on PostgreSQL · Vitest.

## Development

```bash
npm install
cp .env.example .env      # set DATABASE_URL to a Postgres database
npx prisma migrate deploy
npx prisma db seed        # reference data only: aggregators and evidence categories
npm run dev
```

Open http://localhost:3000.

## Scripts

- `npm run dev`: start the development server
- `npm run build`: production build
- `npm run start`: run the production build
- `npm run lint`: run ESLint

## Data

The seeds and test fixtures are synthetic. `prisma/dev-seed.ts` adds one
clearly fictional QA restaurant for trying the import wizard locally.

## Licence

[MIT](LICENSE). The NobleArc name and logo are not licensed for use as your own
branding.
