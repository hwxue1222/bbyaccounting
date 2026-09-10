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

/**
 * readiness (depends on DB)
 */
app.use('/api/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    await ensureMigrated()
    res.status(200).json({ success: true, message: 'ready' })
  } catch (error: any) {
    const msg = typeof error?.message === 'string' ? error.message : ''
    const errorId = crypto.randomUUID()
    const mapped =
      msg.includes('Missing DATABASE_URL')
        ? { status: 503, error: 'Missing DATABASE_URL' }
        : msg.includes('Missing JWT_SECRET')
          ? { status: 503, error: 'Missing JWT_SECRET' }
          : msg.includes('ECONNREFUSED')
            ? { status: 503, error: 'Database connection failed' }
            : msg.includes('password authentication failed')
              ? { status: 503, error: 'Database authentication failed' }
              : { status: 500, error: 'Server internal error' }
    res.status(mapped.status).json({ success: false, error: mapped.error, errorId })
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
  const errorId = crypto.randomUUID()

  const mapped =
    msg.includes('Missing DATABASE_URL')
      ? { status: 503, error: 'Missing DATABASE_URL' }
      : msg.includes('Missing JWT_SECRET')
        ? { status: 503, error: 'Missing JWT_SECRET' }
        : msg.includes('ECONNREFUSED')
          ? { status: 503, error: 'Database connection failed' }
          : msg.includes('password authentication failed')
            ? { status: 503, error: 'Database authentication failed' }
            : { status: 500, error: 'Server internal error' }

  res.status(mapped.status).json({ success: false, error: mapped.error, errorId })
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
