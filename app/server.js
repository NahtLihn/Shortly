import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  REDIS_HOST = '127.0.0.1',
  REDIS_PORT = '6379',
  REDIS_PASSWORD = '',
  REDIS_USE_TLS = 'false',
  BASE_URL = 'localhost:3000',
  RATE_MAKE_MAX = '20',
  CODE_LEN = '7',
  PORT = '3000'
} = process.env;

const redis = new Redis({
  host: REDIS_HOST,
  port: Number(REDIS_PORT),
  password: REDIS_PASSWORD ? REDIS_PASSWORD : undefined,
  enableAutoPipelining: true,
  ...(REDIS_USE_TLS === 'true' ? { tls: {} } : {})
});

redis.on('error', (err) => {
  console.error('[redis] error', err);
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const baseHost = (() => {
  try {
    return new URL(`http://${BASE_URL}`).host.toLowerCase();
  } catch {
    return BASE_URL.toLowerCase();
  }
})();

const codeLength = Number.parseInt(CODE_LEN, 10) || 7;
const rateLimitMax = Number.parseInt(RATE_MAKE_MAX, 10) || 20;

function getClientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (typeof header === 'string' && header.length > 0) {
    return header.split(',')[0].trim();
  }
  if (Array.isArray(header) && header.length > 0) {
    return header[0];
  }
  return req.socket.remoteAddress || 'unknown';
}

function formatDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatDisplayDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toShortUrl(code) {
  return `https://${BASE_URL.replace(/\/$/, '')}/${code}`;
}

function validateLongUrl(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new HttpError(400, 'longUrl is required.');
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch (err) {
    throw new HttpError(400, 'longUrl must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, 'URL must use http or https.');
  }
  if (parsed.host.toLowerCase() === baseHost) {
    throw new HttpError(400, 'Cannot shorten URLs for this service host.');
  }
  return parsed;
}

async function ensureUniqueCode() {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const candidate = nanoid(codeLength);
    const exists = await redis.exists(`url:${candidate}`);
    if (!exists) {
      return candidate;
    }
  }
  throw new HttpError(500, 'Failed to generate unique code. Please retry.');
}

app.post('/api/shorten', async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    const rateKey = `rate:mk:${ip}`;
    const [[rateErr, rateCount]] = await redis
      .multi()
      .incr(rateKey)
      .expire(rateKey, 60, 'NX')
      .exec();

    if (rateErr) {
      throw rateErr;
    }

    if (Number(rateCount) > rateLimitMax) {
      throw new HttpError(429, 'Rate limit exceeded. Try again soon.');
    }

    const parsedUrl = validateLongUrl(req.body?.longUrl);
    const normalizedUrl = parsedUrl.toString();

    const hash = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
    const mapKey = `map:sha:${hash}`;
    const existingCode = await redis.get(mapKey);

    if (existingCode) {
      return res.json({ ok: true, code: existingCode, short: toShortUrl(existingCode) });
    }

    const code = await ensureUniqueCode();
    const createdAt = new Date().toISOString();

    const multi = redis.multi();
    multi.set(mapKey, code);
    multi.hset(`url:${code}`, { long: normalizedUrl, createdAt });
    multi.set(`stats:clicks:${code}`, 0, 'NX');
    await multi.exec();

    return res.status(201).json({ ok: true, code, short: toShortUrl(code) });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/stats/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const urlKey = `url:${code}`;
    const urlData = await redis.hgetall(urlKey);

    if (!urlData || !urlData.long) {
      throw new HttpError(404, 'Short URL not found.');
    }

    const dailyDates = [];
    const now = new Date();
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      date.setUTCDate(date.getUTCDate() - offset);
      dailyDates.push(date);
    }

    const statsPipeline = redis.multi();
    statsPipeline.get(`stats:clicks:${code}`);
    statsPipeline.pfcount(`stats:uv:${code}`);
    dailyDates.forEach((date) => {
      statsPipeline.get(`stats:day:${code}:${formatDateKey(date)}`);
    });

    const statsResults = await statsPipeline.exec();

    const totalClicks = Number(statsResults[0][1] || 0);
    const uniqueVisitors = Number(statsResults[1][1] || 0);

    const last7Days = dailyDates.map((date, index) => {
      const resultIndex = index + 2;
      const value = statsResults[resultIndex]?.[1] || 0;
      return {
        date: formatDisplayDate(date),
        clicks: Number(value || 0)
      };
    });

    const referrersRaw = await redis.zrevrange(`stats:ref:${code}`, 0, 9, 'WITHSCORES');
    const topReferrers = [];
    for (let i = 0; i < referrersRaw.length; i += 2) {
      topReferrers.push({
        host: referrersRaw[i],
        clicks: Number(referrersRaw[i + 1] || 0)
      });
    }

    return res.json({
      ok: true,
      code,
      longUrl: urlData.long,
      createdAt: urlData.createdAt,
      totalClicks,
      uniqueVisitors,
      last7Days,
      topReferrers
    });
  } catch (err) {
    return next(err);
  }
});

app.get('/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const data = await redis.hgetall(`url:${code}`);

    if (!data || !data.long) {
      return res.status(404).send('Not found');
    }

    const originalUrl = data.long;

    const now = new Date();
    const dayKey = formatDateKey(now);
    const ip = getClientIp(req);

    const refererHeader = req.get('referer');
    let refererHost;
    if (refererHeader) {
      try {
        const parsedReferer = new URL(refererHeader);
        refererHost = parsedReferer.host;
      } catch (err) {
        refererHost = undefined;
      }
    }

    const multi = redis.multi();
    multi.incr(`stats:clicks:${code}`);
    multi.incr(`stats:day:${code}:${dayKey}`);
    if (ip) {
      multi.pfadd(`stats:uv:${code}`, ip);
    }
    if (refererHost) {
      multi.zincrby(`stats:ref:${code}`, 1, refererHost);
    }
    await multi.exec();

    return res.redirect(302, originalUrl);
  } catch (err) {
    return next(err);
  }
});

app.use((err, req, res, next) => {
  const status = err instanceof HttpError && err.status ? err.status : err.status || 500;
  const message = err instanceof HttpError ? err.message : err.message || 'Internal Server Error';

  if (status >= 500) {
    console.error('[error]', err);
  }

  if (req.path.startsWith('/api/')) {
    res.status(status).json({ ok: false, error: message });
    return;
  }

  res.status(status).send(message);
});

app.listen(Number(PORT), () => {
  console.log(`Shortly server listening on port ${PORT}`);
});
