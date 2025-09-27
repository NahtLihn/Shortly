# Shortly

Shortly is a minimal URL shortener with click analytics built with Node.js, Express, and Redis.

## Getting started

1. Clone the repository and switch into the `app` directory:

   ```bash
   cd app
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start a Redis instance locally (for example using Docker):

   ```bash
   docker run -p 6379:6379 redis:7
   ```

4. Create a `.env` file based on `.env.example` and adjust values as needed.

5. Start the server:

   ```bash
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000) and shorten a link.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `REDIS_HOST` | Redis host or endpoint | `127.0.0.1` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Password / auth token (blank for none) | *(empty)* |
| `REDIS_USE_TLS` | Set to `true` for TLS connections (e.g. ElastiCache) | `false` |
| `BASE_URL` | Public base host used for generated links | `localhost:3000` |
| `RATE_MAKE_MAX` | Max links per IP per 60 seconds | `20` |
| `CODE_LEN` | Length of generated codes | `7` |
| `PORT` | Port for the HTTP server | `3000` |

### Amazon ElastiCache notes

If you are connecting to an Amazon ElastiCache Redis cluster that requires TLS and an auth token, set the following values:

```env
REDIS_HOST=<primary-endpoint>
REDIS_PORT=6380
REDIS_PASSWORD=<auth-token>
REDIS_USE_TLS=true
```

## Project structure

```
app/
├─ public/
│  └─ index.html
├─ server.js
├─ package.json
└─ .env.example
```

## API overview

- `POST /api/shorten` — Shorten a URL. Body: `{ "longUrl": "https://..." }`
- `GET /:code` — Redirect to the original URL and record analytics.
- `GET /api/stats/:code` — Retrieve stats, including totals, last 7 days, and top referrers.

## Running tests

This project does not include automated tests. Run `npm start` and exercise the API manually with a tool like `curl` or Postman.
