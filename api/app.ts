/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'crypto'
import authRoutes from './routes/auth.js'
import cookieParser from 'cookie-parser'
import { ensureMigrated } from './lib/migrate.js'
import orgRoutes from './routes/orgs.js'
import settingsRoutes from './routes/settings.js'
import journalRoutes from './routes/journals.js'
import inventoryRoutes from './routes/inventory.js'
import fixedAssetsRoutes from './routes/fixedAssets.js'
import reportRoutes from './routes/reports.js'
import usersRoutes from './routes/users.js'

// load env
dotenv.config()

const app: express.Application = express()

function buildInfo() {
  const commit = typeof process.env.VERCEL_GIT_COMMIT_SHA === 'string' ? process.env.VERCEL_GIT_COMMIT_SHA : null
  const deployment = typeof process.env.VERCEL_DEPLOYMENT_ID === 'string' ? process.env.VERCEL_DEPLOYMENT_ID : null
  const env = typeof process.env.VERCEL_ENV === 'string' ? process.env.VERCEL_ENV : null
  return {
    commit: commit ? commit.slice(0, 7) : null,
    deployment,
    env,
    now: new Date().toISOString(),
  }
}

const originEnv = process.env.APP_ORIGIN
const allowedOrigins = originEnv ? originEnv.split(',').map((x) => x.trim()).filter(Boolean) : null

app.use(
  cors({
    origin: allowedOrigins && allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  }),
)
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  }
  next()
})

/**
 * liveness
 */
app.use(
  '/api/health',
  (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

app.use('/api/version', (_req: Request, res: Response): void => {
  res.status(200).json({
    success: true,
    build: buildInfo(),
    env: {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasJwtSecret: Boolean(process.env.JWT_SECRET),
      appOrigin: typeof process.env.APP_ORIGIN === 'string' ? process.env.APP_ORIGIN : null,
    },
  })
})

/**
 * readiness (depends on DB)
 */
app.use('/api/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
    const hasJwtSecret = Boolean(process.env.JWT_SECRET)
    const appOrigin = typeof process.env.APP_ORIGIN === 'string' ? process.env.APP_ORIGIN : null

    if (!hasDatabaseUrl) {
      res.status(503).json({
        success: false,
        error: 'Missing DATABASE_URL',
        errorId: crypto.randomUUID(),
        build: buildInfo(),
        env: { hasDatabaseUrl, hasJwtSecret, appOrigin },
      })
      return
    }
    if (!hasJwtSecret) {
      res.status(503).json({
        success: false,
        error: 'Missing JWT_SECRET',
        errorId: crypto.randomUUID(),
        build: buildInfo(),
        env: { hasDatabaseUrl, hasJwtSecret, appOrigin },
      })
      return
    }

    await ensureMigrated()
    res.status(200).json({
      success: true,
      message: 'ready',
      build: buildInfo(),
      env: { hasDatabaseUrl, hasJwtSecret, appOrigin },
    })
  } catch (error: any) {
    const msg = typeof error?.message === 'string' ? error.message : ''
    const pgCode = typeof error?.code === 'string' ? error.code : null
    const errorId = crypto.randomUUID()

    const env = {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasJwtSecret: Boolean(process.env.JWT_SECRET),
      appOrigin: typeof process.env.APP_ORIGIN === 'string' ? process.env.APP_ORIGIN : null,
    }

    const normalized = msg.toLowerCase()
    const mapped = normalized.includes('missing database_url')
      ? { status: 503, error: 'Missing DATABASE_URL', code: 'MISSING_DATABASE_URL' }
      : normalized.includes('missing jwt_secret')
        ? { status: 503, error: 'Missing JWT_SECRET', code: 'MISSING_JWT_SECRET' }
        : normalized.includes('password authentication failed') || normalized.includes('authentication failed')
          ? { status: 503, error: 'Database authentication failed', code: 'DB_AUTH_FAILED' }
          : normalized.includes('econnrefused') || normalized.includes('enotfound') || normalized.includes('etimedout') || normalized.includes('timeout')
            ? { status: 503, error: 'Database connection failed', code: 'DB_CONN_FAILED' }
            : pgCode === '42501' || (normalized.includes('permission') && normalized.includes('extension'))
              ? { status: 503, error: 'Database permission denied (create extension)', code: 'DB_PERMISSION' }
              : { status: 500, error: 'Server internal error', code: 'UNKNOWN' }

    console.error(`[ready ${errorId}]`, msg)
    res.status(mapped.status).json({
      success: false,
      error: mapped.error,
      code: mapped.code,
      errorId,
      build: buildInfo(),
      env,
      pgCode,
    })
  }
})

app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.path === '/api/health' || req.path === '/api/ready') {
      next()
      return
    }
    await ensureMigrated()
    next()
  } catch (e) {
    next(e)
  }
})

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)
app.use('/api/orgs', orgRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/journals', journalRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/fixed-assets', fixedAssetsRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/users', usersRoutes)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  const msg = typeof error?.message === 'string' ? error.message : ''
  const pgCode = typeof (error as any)?.code === 'string' ? (error as any).code : null
  const errorId = crypto.randomUUID()

  console.error(`[api ${errorId}] ${req.method} ${req.path}`, msg)

  const normalized = msg.toLowerCase()
  const mapped = normalized.includes('missing database_url')
    ? { status: 503, error: 'Missing DATABASE_URL', code: 'MISSING_DATABASE_URL' }
    : normalized.includes('missing jwt_secret')
      ? { status: 503, error: 'Missing JWT_SECRET', code: 'MISSING_JWT_SECRET' }
      : normalized.includes('password authentication failed') || normalized.includes('authentication failed')
        ? { status: 503, error: 'Database authentication failed', code: 'DB_AUTH_FAILED' }
        : normalized.includes('econnrefused') || normalized.includes('enotfound') || normalized.includes('etimedout') || normalized.includes('timeout')
          ? { status: 503, error: 'Database connection failed', code: 'DB_CONN_FAILED' }
          : pgCode === '42501' || (normalized.includes('permission') && normalized.includes('extension'))
            ? { status: 503, error: 'Database permission denied (create extension)', code: 'DB_PERMISSION' }
            : { status: 500, error: 'Server internal error', code: 'UNKNOWN' }

  res.status(mapped.status).json({
    success: false,
    error: mapped.error,
    code: mapped.code,
    errorId,
    build: buildInfo(),
    env: {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasJwtSecret: Boolean(process.env.JWT_SECRET),
      appOrigin: typeof process.env.APP_ORIGIN === 'string' ? process.env.APP_ORIGIN : null,
    },
    pgCode,
  })
})

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
