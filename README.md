# GovSignal Backend API

Federal bid intelligence platform — Node.js/Express backend with PostgreSQL.

## Stack
- **Runtime**: Node.js 20
- **Framework**: Express.js
- **Database**: PostgreSQL via Prisma ORM
- **Auth**: JWT (jsonwebtoken)
- **Payments**: Stripe
- **Email**: Nodemailer (works with Resend, SendGrid, etc.)
- **Jobs**: node-cron (daily digest, SAM.gov sync)

---

## Quick Deploy — Railway (Recommended, ~10 minutes)

Railway is the fastest way to deploy this. Free tier available.

1. **Create account** at railway.app
2. **New Project → Deploy from GitHub repo** (push this code to GitHub first)
3. **Add PostgreSQL**: In your Railway project → New → Database → PostgreSQL
4. **Set environment variables** (see `.env.example`) in Railway → Variables tab
5. Railway auto-deploys on every push. Done.

**Your API will be live at**: `https://your-app.railway.app`

---

## Quick Deploy — Render

1. Push code to GitHub
2. render.com → New Web Service → Connect repo
3. Build command: `npm install && npx prisma generate && npx prisma migrate deploy`
4. Start command: `node src/index.js`
5. Add a PostgreSQL database in Render dashboard
6. Set all env vars from `.env.example`

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in values
cp .env.example .env

# 3. Start PostgreSQL (Docker)
docker run --name govsignal-db -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=govsignal -p 5432:5432 -d postgres:16

# 4. Run database migrations
npx prisma migrate dev --name init
npx prisma generate

# 5. (Optional) Seed with test data
npm run db:seed

# 6. Start dev server
npm run dev
# API running at http://localhost:3001
```

---

## Docker Compose (Full Stack)

```bash
cp .env.example .env
# Fill in .env values, then:
docker-compose up -d
# API at http://localhost:3001
```

---

## API Endpoints

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Login, get JWT |
| GET | `/api/auth/me` | ✓ | Get current user |
| PATCH | `/api/auth/profile` | ✓ | Update profile + API key |
| POST | `/api/auth/forgot-password` | — | Send reset email |
| POST | `/api/auth/reset-password` | — | Reset with token |

### Opportunities
| Method | Endpoint | Auth | Plan | Description |
|--------|----------|------|------|-------------|
| GET | `/api/opportunities` | ✓ | FREE(10) / PRO | Search + score from SAM.gov |
| GET | `/api/opportunities/:noticeId` | ✓ | FREE | Single opportunity detail |
| GET | `/api/opportunities/awards/history` | ✓ | PRO+ | Competitor award history |

Query params: `naicsCode`, `setAside`, `agency`, `keyword`, `type`, `limit`, `daysBack`

### Watchlist
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/watchlist` | ✓ | Get saved opportunities |
| POST | `/api/watchlist` | ✓ | Save an opportunity |
| DELETE | `/api/watchlist/:noticeId` | ✓ | Remove from watchlist |

### Saved Searches
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/searches` | ✓ | List saved searches |
| POST | `/api/searches` | ✓ | Save a search with alert |
| DELETE | `/api/searches/:id` | ✓ | Delete saved search |

### Past Performance
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/performance` | ✓ | List entries |
| POST | `/api/performance` | ✓ | Add entry |
| PATCH | `/api/performance/:id` | ✓ | Update entry |
| DELETE | `/api/performance/:id` | ✓ | Delete entry |

### Digest
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/digest/settings` | ✓ | Get digest settings |
| PATCH | `/api/digest/settings` | ✓ | Update digest settings |
| POST | `/api/digest/test` | ✓ | Send test digest now |

### Stripe
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/stripe/checkout` | ✓ | Create checkout session |
| POST | `/api/stripe/portal` | ✓ | Open billing portal |
| POST | `/api/stripe/webhook` | — | Stripe event handler |

---

## Connecting the Frontend

In your React app (`govcon-tracker.jsx`), replace the direct SAM.gov API calls with calls to this backend:

```javascript
// Instead of calling SAM.gov directly:
const res = await fetch(`https://api.sam.gov/...`);

// Call your backend:
const token = localStorage.getItem("token"); // JWT from login
const res = await fetch("https://your-api.railway.app/api/opportunities?naicsCode=541512", {
  headers: { Authorization: `Bearer ${token}` }
});
const { data } = await res.json();
```

### Login flow example:
```javascript
// Register
const res = await fetch("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name })
});
const { token } = await res.json();
localStorage.setItem("token", token);

// Login
const res = await fetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password })
});
const { token } = await res.json();
```

---

## Stripe Setup (Payments)

1. Create account at stripe.com
2. Dashboard → Products → Create two products:
   - **GovSignal Pro** — $49/month recurring → copy Price ID → `STRIPE_PRO_PRICE_ID`
   - **GovSignal Agency** — $149/month recurring → copy Price ID → `STRIPE_AGENCY_PRICE_ID`
3. Developers → API Keys → copy Secret Key → `STRIPE_SECRET_KEY`
4. Developers → Webhooks → Add endpoint: `https://your-api.railway.app/api/stripe/webhook`
   - Events to listen for: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Copy Signing Secret → `STRIPE_WEBHOOK_SECRET`

---

## Email Setup (Resend — Free 3K emails/month)

1. Sign up at resend.com
2. Add your domain (or use their sandbox for testing)
3. API Keys → Create API Key → copy it
4. In `.env`:
   ```
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=465
   SMTP_USER=resend
   SMTP_PASS=re_your_api_key_here
   EMAIL_FROM=GovSignal <noreply@yourdomain.com>
   ```

---

## SAM.gov API Key

- **Personal key** (free): sam.gov → log in → Profile → Public API Key → Request Key. Limit: 10 req/day
- **System account key** (free): Gives 1,000 req/day — apply at sam.gov/system-accounts. Takes 1-2 weeks to approve. This is what you want for production.

---

## Pricing Plans

| Feature | FREE | PRO ($49/mo) | AGENCY ($149/mo) |
|---------|------|--------------|------------------|
| Opportunities per search | 10 | Unlimited | Unlimited |
| AI fit scoring | ✓ | ✓ | ✓ |
| Watchlist | ✓ | ✓ | ✓ |
| Daily email digest | ✗ | ✓ | ✓ |
| Saved search alerts | ✗ | ✓ | ✓ |
| Award/competitor history | ✗ | ✓ | ✓ |
| Past performance log | ✓ | ✓ | ✓ |
| Team seats | 1 | 1 | 5 |

---

## Background Jobs

Two cron jobs run automatically when the server starts:

- **Digest Job** — runs every hour, sends email digests to PRO/AGENCY users whose send time matches
- **SAM Sync Job** — runs every 6 hours, caches fresh opportunities and sends saved search alerts

---

## Questions?

Hand this README to your developer. Estimated setup time for an experienced Node.js developer: **2-4 hours** from zero to live.
